# Seed music sources (CC0 only)

Downloaded by `scripts/fetch_seed_music.py` into this directory, then seeded into
the `music_tracks` table by `pnpm seed` (uploaded to the `derived/_seed/` prefix).

Only CC0 / public-domain tracks belong here (SPEC §12 license rule). Verify the
license on the source page before adding a row.

| filename           | title             | source                        | license |
| ------------------ | ----------------- | ----------------------------- | ------- |
| seed-upbeat.mp3    | Upbeat Cheerful   | https://freepd.com/upbeat.php | CC0 1.0 |
| seed-cinematic.mp3 | Cinematic Ambient | https://freepd.com/epic.php   | CC0 1.0 |

Direct URLs used by the fetch script (FreePD serves flat mp3 paths):

- seed-upbeat.mp3: https://freepd.com/music/Funshine.mp3
- seed-cinematic.mp3: https://freepd.com/music/Distant%20Lands.mp3

Note: dev/CI environments use the synthetic `e2e/fixtures/music.mp3` (generated
by `scripts/make_fixtures.sh`, no external network) — these downloads are for
real deployments.
