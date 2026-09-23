# @touchstone/task-pack-trivial-accept

WP-9's own required proof, not a real experiment: spec §15's WP-9 item 2 says a second, trivial
task pack must load and run end to end with **zero changes outside its own directory** — that's
the property this package exists to demonstrate. Its `gate()` accepts a submission iff its text
contains a configured required substring. Nothing about `@touchstone/gate-market-agents` (the
bench) or `@touchstone/task-pack-sdk` (the shared interface) changed to make this pack work.
