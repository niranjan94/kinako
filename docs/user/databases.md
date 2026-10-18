# Databases

Connect to Postgres and SQLite in **Settings → Databases**, or add a connection
from the database explorer. The environment opens the database, so a remote
browser or phone can reach databases available only on that machine. SQLite
paths refer to existing files on the environment.

Choose where a connection is **Available in**:

- **This project** makes it available to one project on one environment.
- **Every project on this environment** makes it available to every project on
  that environment.
- **Every connected environment** copies a Postgres connection to every
  reachable environment when you save. Use this for a shared hosted database,
  rather than `localhost`. SQLite connections stay on one environment.

Passwords stay on each environment. When editing, keep, replace, or remove the stored password; it is never shown again. For connections on every environment, Settings shows missing and older copies. Reconnect an environment and use **Copy to** to update its copy; enter the password again when needed. Edits and deletions of these copies do not sync in the background. If an environment was offline during a deletion, this device keeps a cleanup reminder and marks that copy when it reconnects. Delete the remaining copy explicitly.

On web and desktop, choose **Databases** from the right panel's new-tab menu, use **Database explorer** in the command palette, or press Cmd/Ctrl+Alt+Q. Expand a connection, schema, and table to inspect columns. **Find database table…** in the command palette focuses the explorer's search, which looks through connections you have already expanded. Double-click a table or press Enter to read its rows. Click a column header to sort, or use SQL expressions in WHERE and ORDER BY to filter and sort. Each table page is a fresh read, so changes made between pages can appear as you scroll.

Query consoles and table tabs are kept per thread in this browser, so a reload or reopening the panel restores their SQL and filters. Results and sessions are not kept. Use the connection menu at the right of the editor toolbar to point a console at another connection.

Each query tab has its own session. Settings such as Postgres `search_path` and temporary tables persist between statements in that tab. Cmd/Ctrl+Enter runs the selection or the statement at the cursor; Cmd/Ctrl+Shift+Enter or **Run options → Run entire script** runs all statements in order, stops at the first failure, and shows the last result. Postgres errors are underlined in the editor. Statements that update or delete without WHERE, or that drop or truncate data, ask for confirmation unless the connection is read-only. Press Ctrl+Space for table, column, alias, and SQL function suggestions. Metadata loads as needed without expanding the explorer. Tab or Enter accepts a suggestion; Esc dismisses it. Use the SQL file button to open or save queries with a path relative to the project. Saving asks before overwriting a file the console did not write, and closing a console with unsaved SQL asks first. Drag the divider between the editor and results to adjust their height; the database explorer also resizes. Maximize the panel when working with wide tables.

Cancel a query with the stop button or Esc in the editor. Cancelling SQLite closes its session; the next run opens a fresh one. Closing a query tab releases its result and session. Unread results expire after 60 seconds to release database locks, while the editor remains available. An unused editor session expires after 30 minutes. Rerun a query if its result has expired.

Scroll to load more rows. Shift-click, drag, or use Shift+arrow keys to select a rectangle, then copy it. Open a cell with a double-click or Enter to inspect its value. NULL is shown explicitly. Long text is shortened to 2,000 characters and the viewer reports its full length, formats JSON, and can copy the value. CSV and JSON export only the loaded rows, including any shortened text, and are named after the table or console.

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
