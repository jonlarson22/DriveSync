# DriveSync Compare

Compare two folders or drives and copy the differences you select. Built as a free, no-subscription replacement for the basic GoodSync compare-and-copy workflow — made for keeping two photo backup drives in sync.

## What it does
- Pick a **Left (A)** and **Right (B)** folder or drive
- **Compare** recursively, three ways:
  - **Quick** — size only (fastest)
  - **Standard** — size + modified date (fast, good for most syncs)
  - **Exact** — SHA-256 hash of every file (slowest, certain — best for photo archives, catches same-size/different-photo cases)
- Results grouped as: **Only in Left**, **Only in Right**, **Different in both**, **Identical**
- **Folders are compared too** (v1.1): every folder — including empty ones — gets its own 📁 row. Selecting a folder that's only on one side creates it on the other, so you can organize on a "live" drive and mirror the structure to its backup even where no files have landed yet. Folders are created shallowest-first, before the files that go in them.
- Check the files/folders you want, then **Copy selected Left → Right** or **Right → Left**
- **Folder rename detection** (v1.2): if a folder was renamed on one side, the compare notices — a folder that exists under different names but holds matching contents (same file names + sizes, or hash-identical in Exact mode) is offered in a "Possible folder renames" panel. Applying a rename just renames the folder in place on the other drive: instant, no files recopied, no duplicate left behind. Empty folders are never auto-matched (they'd match everything), and ambiguous matches are skipped.
- **Preview panel** (v1.2): click any file row for a side-by-side preview — images show full previews with dimensions, text files show their contents, videos/other files show details with an Open button to view them in your usual app. Made for eyeballing "Different" photos before choosing which way to copy.
- Save a **CSV report** of the full comparison

## Safety
- **It never deletes anything.** There is no delete or mirror-erase function. The one in-place change it can make is a *rename you explicitly apply* from the rename-detection panel, and only when the two folders' contents demonstrably match.
- Identical files are never copied.
- Copying a "Different" file overwrites the other side — you get a warning with the exact overwrite count before anything happens.
- Nothing is pre-selected after a compare, so a stray click can't start a copy. Bulk-select buttons are there to make selecting everything in a direction one click.
- Copied files keep their original modified date.
- Symlinks are skipped (avoids loops and double-counting).

## Run / build
- Dev: `npm install` then `npm start`
- Test the compare/copy logic without the UI: `npm test`
- Package: `npm run package-win` / `npm run package-mac`

Unsigned builds: on Windows, SmartScreen may ask — choose "More info → Run anyway". On Mac, right-click the app → Open the first time.
