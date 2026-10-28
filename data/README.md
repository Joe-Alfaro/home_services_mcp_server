# data

Put the provided source data pack here: copy the contents of the pack folder into this folder as
they are. Setup reads from here unless `DATA_PACK_DIR` points somewhere else.

Expected layout:

```text
data/
  sources/
    jobber/*.json
    housecall_pro/<company>/*.json
    workiz/<account>/*.json
    spreadsheet/*.csv
    calendars/*.ics
    profiles/*.json
  reference/street_segments.csv
```

Everything in this folder except this file and `.gitkeep` is git-ignored and never committed.
