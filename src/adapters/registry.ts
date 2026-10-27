import { housecallProAdapter } from './housecallPro.ts'
import { icsAdapter } from './ics.ts'
import { jobberAdapter } from './jobber.ts'
import { profilesAdapter } from './profiles.ts'
import { spreadsheetAdapter } from './spreadsheet.ts'
import type { SourceAdapter } from './types.ts'
import { workizAdapter } from './workiz.ts'

/** The one list of source adapters (R2). Adding a source means adding it here. */
export const adapters: readonly SourceAdapter[] = [
  jobberAdapter,
  housecallProAdapter,
  workizAdapter,
  spreadsheetAdapter,
  icsAdapter,
  profilesAdapter,
]
