# QIS Purchasing Dashboard

The purchasing team's own board system, fully separate from the sales dashboard:
Supplier Research and Purchase Orders boards, the Supplier Matrix, an Overview
and a My Work list. Replaces the two Monday.com purchasing boards.

- **Hosting:** GitHub Pages (static, no build step) — same pattern as the sales
  dashboard, its own repo and URL.
- **Data:** Supabase project `qis-quoting-tool`, tables prefixed `pd_`.
  Unlike the `sd_` tables there is **no anonymous access at all**: every table
  has row-level security limited to signed-in purchasing staff (`pd_users` —
  Liam, Rick, Will). The page only ships the public anon key.
- **Sign-in:** Supabase email + password. Open sign-ups are off; accounts are
  created by hand. Change password from the menu next to your name.
- **Writes (board edits):** every edit to a card PATCHes only the changed
  field; an `updated_*` stamp and a field-by-field activity log are written by
  database triggers whoever the writer is. New cards get `9` + 9 random digits
  + a Luhn check digit. (Container Planning's own tables save differently:
  see below.)
- **Files:** private Supabase Storage bucket `pd-files`, path `<item id>/<name>`,
  opened via short-lived signed URLs.
- **Unleashed:** the PO card's Unleashed tab reads the live purchase order
  through the `pd-unleashed` Edge Function. The connector token lives in the
  locked `pd_private_config` table server-side, never in the page. Read-only
  from the dashboard; PO writes stay on the preview→confirm connector protocol.
- **Board rules** (mirrors of the Monday behaviour Liam approved): a PO's group
  follows its Health (and dragging between groups sets Health); marking landed
  stamps the date; monthly forecast cards roll to the 1st; approved research
  offers "Start a PO draft" and links both cards.

- **Container Planning** (`planning.js` + `planning.css`): Forecast and
  Container tabs for overseas containers. Reads and writes its own `pd_cp_`
  tables: categories (target months), SKUs (monthly rates) and shared drafts.
  A draft is saved whole, with an `updated_at` check so two people cannot
  overwrite each other; these tables carry `updated_*` stamps but no activity
  log. It reads monthly usage, live stock and PO status (through
  `pd-unleashed`), refreshes usage through the `pd-cp-usage` Edge Function,
  and "Start a PO card" adds a card and its first update to the Purchase
  Orders board. Loads its data on first visit only, and the boards still draw
  if `planning.js` itself fails to load, so it can never block the boards.
  Nothing on the page writes to Unleashed. No carton costs, prices or test
  data live in this repo: they are rows in Supabase behind sign-in.

Files: `index.html` · `config.js` (public keys) · `defs.js` (groups/statuses) ·
`db.js` (auth + data layer) · `core.js` · `board.js` · `drawer.js` ·
`planning.js` (Container Planning page) · `purchasing.js` · `app.css` ·
`planning.css` (Container Planning styles, all under `.planning`).

Migration from Monday (21/09/2026): `TEST — Purchasing Orders` (15 cards),
`TEST — Supplier Research` (3 cards), `Supplier Matrix` (71 suppliers), loaded
by `scripts/` in the build session's scratchpad; migrated rows carry
`created_by = monday-migration` and keep their Monday item IDs.
