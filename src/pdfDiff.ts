import * as pdfjsLib from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { getTextContentSafely } from './pdfTextContent'

function isTextItem(item: TextItem | { type: string }): item is TextItem {
  return 'str' in item
}

async function getPageTextKeys(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
): Promise<Set<string>> {
  const page = await doc.getPage(pageNumber)
  const content = await getTextContentSafely(page)
  const keys = new Set<string>()
  for (const item of content.items) {
    if (!isTextItem(item) || !item.str.trim()) continue
    keys.add(itemKey(item))
  }
  return keys
}

/**
 * A stable-ish key for matching the "same" text run across two revisions:
 * exact text plus a coarsely-rounded position, so tiny sub-pixel rendering
 * differences between otherwise-identical runs don't register as changes,
 * while genuinely moved/edited text still does.
 */
function itemKey(item: TextItem): string {
  const x = Math.round(item.transform[4])
  const y = Math.round(item.transform[5])
  return `${item.str}@${x},${y}`
}

/**
 * Compares a document as it existed at an earlier revision (e.g. truncated
 * to a signature's covered byte range) against the current document, and
 * reports whether any visible page text is present now that wasn't present
 * at the same position in the earlier revision. This is a presence check
 * (added/moved text), not a character-level diff: a text run that moved or
 * was reworded counts as changed, which is enough to answer "did the
 * visible content change" without needing a full diff algorithm.
 */
export async function hasVisibleTextChanged(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): Promise<boolean> {
  const oldTask = pdfjsLib.getDocument({ data: oldBytes })
  const newTask = pdfjsLib.getDocument({ data: newBytes })

  try {
    const [oldDoc, newDoc] = await Promise.all([
      oldTask.promise,
      newTask.promise,
    ])

    for (let pageNumber = 1; pageNumber <= newDoc.numPages; pageNumber++) {
      const newKeys = await getPageTextKeys(newDoc, pageNumber)
      const oldKeys =
        pageNumber <= oldDoc.numPages
          ? await getPageTextKeys(oldDoc, pageNumber)
          : new Set<string>()

      for (const key of newKeys) {
        if (!oldKeys.has(key)) return true
      }
    }

    return false
  } finally {
    void oldTask.destroy()
    void newTask.destroy()
  }
}
