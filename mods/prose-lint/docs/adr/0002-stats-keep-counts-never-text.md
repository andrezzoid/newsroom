# Writing stats keep counts and no text

The stats record, per day, project and session, how many words Claude wrote, how many alerts it wrote, fixed and kept, and how many fix edits it made, plus at most three example matches per rule: no file paths, lines or prose. They stay in the plugin's local store for a year. An alert counts as fixed or kept at its first verdict only, so "kept" means "not fixed in the turn Claude wrote it"; a later fix still strikes it out on its row. The store sits on users' machines, a 4 MiB file, and the stats only need rates, so storing text would cost privacy and room for nothing the views use; changing the record's shape later means migrating every user's stored data.

## Considered Options

Storing each alert's line, for a coach that quotes Claude's own sentences back to it. Rejected for the reasons above; the example matches serve that purpose at a fraction of the size.
