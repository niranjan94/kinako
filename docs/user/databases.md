# Databases

Connect to Postgres and SQLite in **Settings → Databases**, or add a connection
from the database explorer. The environment opens the database, so a remote
browser or phone can reach databases available only on that machine. SQLite
paths refer to existing files on the environment.

Choose where a connection belongs:

- **Project** makes it available to one project on one environment.
- **Environment** makes it available to every project on that environment.
- **Global** copies a Postgres connection to every reachable environment when
  you save. Use this for a shared hosted database, rather than `localhost`.
  SQLite connections cannot be global.

Passwords stay on each environment. When editing, keep, replace, or clear the
stored password; it is never shown again. Global coverage shows missing and
older copies. Reconnect an environment and use **Copy to** to update its copy;
enter the password again when needed. Global edits and deletions do not sync in
the background. If an environment was offline during a deletion, this device
keeps a cleanup reminder and marks that copy when it reconnects. Delete the
remaining copy explicitly.

On web and desktop, choose **Databases** from the right panel's new-tab menu,
use **Database explorer** in the command palette, or press Cmd/Ctrl+Alt+Q.
Expand a connection, schema, and table to inspect columns. **Open table…** in
the command palette opens the explorer; double-click a table or press Enter to read
its rows. Click a column header to sort, or use SQL expressions in WHERE and
ORDER BY to filter and sort.
Each table page is a fresh read, so changes made between pages can appear as
you scroll.

Each query tab has its own session. Settings such as Postgres `search_path`
and temporary tables persist between statements in that tab. Cmd/Ctrl+Enter
runs the selection or the statement at the cursor; **Run options → Run entire script** runs all
statements in order and shows the last result. Press Ctrl+Space for table, column,
alias, and SQL function suggestions. Metadata loads as needed without expanding the
explorer. Tab or Enter accepts a suggestion; Esc dismisses it. Use **SQL files** to open or save queries
with a path relative to the project. Drag the divider between the editor and
results to adjust their height; the database explorer also resizes. Maximize the
panel when working with wide tables.

Cancel a query with **Cancel** or Esc in the editor. Cancelling SQLite closes
its session; the next run opens a fresh one. Closing a query tab releases its
result and session. Unread results expire after 60 seconds to release database
locks, while the editor remains available. An unused editor session expires
after 30 minutes. Rerun a query if its result has expired.

Scroll to load more rows. Shift-click, drag, or use Shift+arrow keys to select a
rectangle, then copy it. Open a cell with a double-click or Enter to inspect its
value. NULL is shown explicitly. Long text is shortened to 2,000 characters and
the viewer reports its full length. CSV and JSON export only the loaded rows,
including any shortened text.

On mobile, open **Databases** from the thread's terminal menu or command
palette. Browse connections, inspect columns, open table rows, and run a
read-only query. Manage connection settings from web or desktop.

Database access requires the environment's terminal permission. Saving,
deleting, and testing connections require permission to change settings.
Agents can use `db_list_connections`, `db_describe`, and `db_query` for their
thread's project. Agent queries use fresh read-only sessions and return at most
500 rows; passwords are never included.

Read-only mode is an accident guard, not a security boundary. For Postgres,
connect with a role limited to SELECT on the data you want to expose. Agents
with shell access can also use database command-line tools independently.
