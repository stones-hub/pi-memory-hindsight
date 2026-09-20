# Hindsight 0.8.3 → 0.10.0 live-upgrade runbook

This document is a plan, not proof that the live upgrade has run. Every live action below requires separate user authorization. Never copy credential values into this repository, logs, evidence, or chat.

## Verified live topology (read-only investigation, 2026-09-18)

- Pi `0.85.1` has the extension pinned to `https://github.com/stones-hub/pi-memory-hindsight.git@v0.3.0`.
- Live container: `hindsight`.
- Live API before upgrade: Hindsight `0.8.3`.
- Current configured image ref: floating `ghcr.io/vectorize-io/hindsight:latest`.
- Current actual image digest: `ghcr.io/vectorize-io/hindsight@sha256:274704505b2720ac9a5c816c559044c1e8c6b51d47017317ae049ed2952f5ab1` (`0.8.3`).
- Rehearsed target image for this runbook: `ghcr.io/vectorize-io/hindsight@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b` (`0.10.0`). Do not use `latest` during upgrade or rollback. This does not constitute live-upgrade authorization.
- Alembic heads were independently derived offline by parsing every migration file inside those two exact image digests with network disabled: `0.8.3` has 80 migration files and sole head `e1f2a3b4c5d6` (`e1f2a3b4c5d6_merge_heads_embedding_drop_and_links_index.py`); `0.10.0` has 103 migration files and sole head `f3a5b7c9d1e2` (`f3a5b7c9d1e2_drop_memory_units_bm25_matview.py`). The 23-file difference agrees with the 23 delta steps observed in the isolated migration log.
- Database mode: embedded pg0/PostgreSQL, bind-mounted from `/Users/yelei/data/docker/hindsight-docker` to `/home/hindsight/.pg0`.
- pg0 directory size during investigation: approximately `2.3G`; `instances/hindsight/data` accounts for approximately `2.2G`.
- Hugging Face cache: `/Users/yelei/data/docker/hindsight-docker-hfcache` → `/home/hindsight/.cache/huggingface`, approximately `478M`. It is not database state and is not part of rollback state.
- Free space on the backing filesystem during investigation: approximately `286GiB`.
- Published ports: host `8888` and `9999`, currently on all interfaces.
- Restart policy: `unless-stopped`.
- Shared memory: `2GiB`.
- Container runs unprivileged as image user `hindsight`/UID 1000; no CPU or memory limit is configured.
- Container's Docker stop timeout is only one second. Every planned stop must use an explicit longer timeout and verify a clean exit.
- `HINDSIGHT_API_WORKER_ID` is absent. The `0.10.0` investigation recommends setting a stable worker ID so task recovery can match work across container recreation.
- Historical launcher: `/Users/yelei/data/docker/hindsight-backup/run-hindsight.sh`. It names the same mounts and ports but predates the current container; its values must not be assumed current without a secret-aware comparison. It contains or may contain credentials and currently has mode `0644`; never print or commit it.
- There are no Docker Compose labels on the current container, so this runbook does not assume a Compose deployment.

## Successfully rehearsed

A fully isolated rehearsal using synthetic data passed:

1. Official `0.8.3` created governed data and configuration.
2. The database was cleanly stopped and cold-snapshotted.
3. The verified snapshot was copied into a separate empty volume.
4. Official `0.10.0` executed the expected 23-step Alembic delta.
5. Existing text, exact governance metadata, governed Bank config, Recall, and Recall scores passed.
6. Post-upgrade update, delete, and create passed.
7. The unchanged pre-upgrade snapshot was restored into another empty volume.
8. Official `0.8.3` booted with the exact original state; upgrade-only changes were absent.
9. Independent review returned PASS.

The rehearsal proves the database migration and snapshot-restore mechanism, not the duration or every content shape in the real `2.3G` database. The rehearsal used Docker named volumes on Docker's Linux filesystem; the live deployment uses a macOS host bind mount. Host-directory copy semantics, ownership, modes, and Docker Desktop translation were not rehearsed and therefore require an explicit copy-integrity gate below.

## Hard safety rules

- Obtain separate authorization for backup/stop, configuration preparation, upgrade/restart, and rollback if needed.
- Keep the live API on `0.8.3` until the extension is already pinned to `v0.3.0` (completed).
- Pause all writers before the cold snapshot. Close every interactive Pi session with this extension loaded, in every project, because the once-per-day maintenance pass can physically delete expired Hindsight documents after an otherwise ordinary settled agent turn. Before stopping Hindsight, mechanically list running Pi processes and obtain user confirmation that no remaining process may load this extension or write memory; do not kill unrelated Pi processes without separate authorization. Do not issue `/memory remember`, update, approve, forget, or maintenance commands.
- Do not run `0.10.0` against the only copy of the database.
- Do not run `0.8.3` against a database already migrated by `0.10.0`.
- Do not enumerate or export memory text merely to validate migration. Use counts, exact known local IDs, governed metadata consistency, health/version, and user-selected functional probes.
- Do not delete the untouched pre-upgrade directory or archive until the user explicitly accepts the upgrade and a retention period has passed.
- Do not expose API keys in `docker inspect` output, shell history, logs, evidence files, or Git.
- Rollback discards every write made after the snapshot. Keep the service read-only in practice until the upgrade acceptance gate passes.

## Required user decisions before execution

1. **Maintenance window:** choose a period in which all Pi memory writes can stop.
2. **Port exposure:** either preserve the current all-interface bindings for minimal behavioral change, or separately authorize hardening to `127.0.0.1:8888` and `127.0.0.1:9999`. Do not combine an unapproved network change with the database migration.
3. **Credential/config source:** authorize a secret-aware reconciliation between the running container and the historical launcher. The preferred result is a mode-`0600` env/config file outside Git plus a launcher that references it; never duplicate secrets into this repository.
4. **Stable worker ID:** approve a stable non-secret value such as `hindsight-main` for `HINDSIGHT_API_WORKER_ID`.
5. **Migration time budget:** choose the maximum permitted interval from new-container start to healthy `0.10.0`; synthetic data cannot predict migration time for the real `2.2G` PostgreSQL data directory.
6. **Backup retention:** choose when the untouched directory, old container, failed/quarantine directory, and tar archive may be deleted after acceptance.
7. **Launcher permissions:** separately authorize tightening the historical secret-bearing launcher from `0644` to `0600`; this is recommended but is not silently bundled into migration authorization.

## Phase 0 — preflight, no service change

Record a redacted evidence directory under `/tmp` and capture:

- current date/time and maintenance owner;
- Pi extension source and installed commit;
- current `/health` and `/version`;
- container ID, exact image ID/repo digest, start time, restart policy, port bindings, mount destinations, shared-memory size, and environment variable names only;
- current pg0 directory size and backing-filesystem free space;
- target `0.10.0` repo digest;
- current-log baseline counts/classes for ERROR, Exception, Traceback, CRITICAL, and Panic, so historical unrelated failures are not confused with new migration failures;
- absence of any prior upgrade working/rollback directory name selected for this run.

Before the maintenance window, pull the exact `0.10.0` digest, verify it appears in local `RepoDigests`, and verify that the exact `0.8.3` digest is still available locally. Do not run `docker image prune` or `docker system prune` until the rollback retention period expires.

Then perform a secret-aware configuration comparison without printing values. The user—not the Agent—must create the external env file in their own shell with shell history disabled. The Agent must not derive or copy secret values from `docker inspect`, the historical launcher, or existing JSON snapshots. The Agent may verify only env-variable names, count, file owner, and mode. Use this name-only form when checking a running container: `docker inspect -f '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' hindsight`.

The user-prepared env file must:

- preserve every effective current Hindsight/HF variable unless `0.10.0` explicitly rejects it;
- add `HINDSIGHT_API_WORKER_ID=hindsight-main` (or the approved stable value);
- have mode `0600` and remain outside Git.

The launch specification must:

- use `--env-file`; never pass `-e KEY=value` secrets on the command line;
- pin the image by digest, never `latest`;
- preserve `/app/start-all.sh`, both bind mounts, `2GiB` shared memory, and approved port bindings;
- use `--restart=no` until the complete acceptance gate passes.

Stop if the actual mount, image digest, database mode, credential source, or free-space assumptions differ from this document.

## Phase 1 — maintenance stop and cold backup

Use a timestamp shared by every path, for example `YYYYMMDD-HHMMSS`. Planned paths:

- live path: `/Users/yelei/data/docker/hindsight-docker`;
- untouched rollback directory: `/Users/yelei/data/docker/hindsight-docker-pre-v0100-<timestamp>`;
- failed/new-version quarantine directory if rollback is needed: `/Users/yelei/data/docker/hindsight-docker-failed-v0100-<timestamp>`;
- archive directory: `/Users/yelei/data/docker/hindsight-backups/v0.8.3-pre-v0.10.0-<timestamp>`.

Procedure:

1. Confirm all writers are paused.
2. Record one final read-only health/version check.
3. Run `docker update --restart=no hindsight` and verify the restart policy changed before stopping anything.
4. Stop `hindsight` with an explicit timeout of at least 60 seconds.
5. Verify container state is `exited`, `Running=false`, and `OOMKilled=false`. Treat PostgreSQL's clean-shutdown log line plus absence of `postmaster.pid` as the primary clean-stop gate; record the actual container exit code rather than assuming only zero is valid.
6. Verify the database process is gone and no `postmaster.pid` remains in the pg0 data directory.
7. Rename the stopped old container to `hindsight-pre-v0100-<timestamp>` and retain it through the rollback retention period. Verify its immutable image ID/repo digest is the recorded `0.8.3` digest. Do not remove it before acceptance.
8. Rename the live pg0 directory to the untouched rollback-directory name on the same filesystem. Do not modify that directory afterward.
9. Create a new empty live path with appropriate ownership and mode.
10. Copy the untouched directory into the new live path while preserving permissions. Prefer performing the copy from a throwaway container running as UID 1000 with source mounted read-only and target read-write, so validation sees Docker's actual bind-mount translation. On APFS, a copy-on-write clone may be used only if metadata and content are verified afterward. This new path is the only copy that `0.10.0` may migrate.
11. Before starting `0.10.0`, first fail if `postmaster.pid` or any other PostgreSQL runtime PID/socket artifact is present; do not silently exclude it. Generate deterministic manifests for both trees containing relative path, file type, mode, owner/group, size, symlink target, and SHA-256 for every regular file. Compare manifests exactly with no unspecified transient-file exclusions, and separately compare top-level `stat` owner/group/mode. Stop if any content or metadata mismatch appears.
12. Independently create a cold tar archive from the untouched directory, write `SHA256SUMS`, and immediately verify it.
13. Record source/copy/archive sizes and ensure they are plausible before proceeding.

Why both copies exist:

- the untouched directory gives the fastest rollback by directory swap;
- the checksummed tar is an independent recovery artifact if either directory is damaged accidentally.

Stop before upgrade if the old container does not stop cleanly, the snapshot contains `postmaster.pid`, the copy/archive fails, checksum verification fails, ownership differs, or free space becomes unsafe.

## Phase 2 — start pinned `0.10.0` against the working copy

1. Create a new container named `hindsight` from the user-prepared, secret-aware `--env-file` configuration. The retained old container already has a timestamped name, so there must be no name collision.
2. Use the exact `0.10.0` digest from this runbook.
3. Mount only the new working-copy live path at `/home/hindsight/.pg0`.
4. Reuse the HF cache mount.
5. Set the approved stable `HINDSIGHT_API_WORKER_ID`.
6. Preserve all other approved runtime settings; do not introduce unrelated changes.
7. Start the container with `--restart=no` and capture logs from startup through migration completion. The first `0.10.0` start may need outbound access to fill missing model/cache artifacts; confirm network availability without changing the shared HF cache contents manually.
8. Wait for `/health` to report healthy and `/version` to report exactly `0.10.0`, but abort when the user-approved migration time budget is exceeded.
9. Confirm logs show exactly 23 Alembic delta steps from the rehearsed `0.8.3` head `e1f2a3b4c5d6` through the `0.10.0` head `f3a5b7c9d1e2`. Scope severe-marker review to logs emitted after the new container start and compare new marker classes against the Phase-0 baseline.
10. Record elapsed migration/startup time and final live-path size.

Do not allow normal writers yet.

## Phase 3 — acceptance gate while writes remain paused

Perform checks in this order:

1. **Platform:** container remains running; health is healthy; version is exactly `0.10.0`; image digest and mount source are exact.
2. **Extension negotiation:** installed `v0.3.0` negotiates `0.10.0` successfully.
3. **Governance config:** for the exact owned Profile Bank and any enabled current Project Bank, verify the four required values without enumerating unrelated Banks:
   - `retain_extraction_mode=chunks`
   - `retain_chunk_size=2048`
   - `enable_observations=false`
   - `enable_auto_consolidation=false`
4. **Read path:** use known local active memory rows to verify exact Document IDs, text hashes, one-unit representation, and governance metadata consistency. Do not print memory text into evidence.
5. **Recall path:** run user-approved representative queries; prove Recall returns valid score objects and that extension governance still admits only matching local active rows.
6. **Maintenance state:** before any real agent turn, inspect `/memory status` for whether automatic maintenance is due. Treat any maintenance pass triggered during acceptance as part of the controlled write window and record its outcome.
7. **Controlled write probe:** only after read checks pass, create one clearly synthetic temporary memory through the extension's normal governed entry point, verify it, update it using the same logical ID/document, then delete it and prove absence. Record IDs/hashes, not text.
8. **Pi diagnostics:** check `/memory status` and `/memory last`; scores should appear only for `0.10.0` recalled items and remain Session-local. Remember that the agent turn needed for `/memory last` may also trigger due maintenance.
9. **Logs:** re-scan only the post-start/post-migration log window for new severe markers.

The user must explicitly accept this gate before normal writes resume. Only after acceptance, run `docker update --restart=unless-stopped hindsight` and verify the policy, then resume normal writers.

## Immediate rollback triggers

Rollback instead of debugging in place if any of these occurs before acceptance:

- migration does not reach healthy `0.10.0` within the agreed window;
- severe migration/database errors appear;
- extension compatibility negotiation fails;
- governed Bank config differs;
- known Document IDs, exact text hashes, one-unit representation, or governance metadata do not match;
- Recall score objects are missing/malformed;
- controlled create/update/delete fails or leaves ambiguous state;
- unexplained data-count or disk-growth anomaly appears.

## Rollback procedure

Normal writers must still be paused.

1. Stop the `0.10.0` container with an explicit timeout and verify clean shutdown if possible.
2. Rename the stopped `0.10.0` container to `hindsight-failed-v0100-<timestamp>`; never start `0.8.3` while the migrated working directory remains at the live path.
3. Rename the migrated live path to the failed/quarantine path.
4. Rename the untouched pre-upgrade directory back to `/Users/yelei/data/docker/hindsight-docker`.
5. Verify the restored path owner/group/mode, checksum-manifest identity, and absence of `postmaster.pid`.
6. Verify the retained old container's immutable image ID/repo digest is exactly the recorded `0.8.3` digest, then rename it from `hindsight-pre-v0100-<timestamp>` back to `hindsight`. This is the primary rollback path and does not re-materialize secrets.
7. Start the retained old container with restart policy still `no`; verify healthy `0.8.3`, extension negotiation, governed config, known Document/hash/metadata checks, and a read-only Recall probe. Restore `unless-stopped` only after rollback acceptance.
8. Reconcile local extension state: record `/memory status` before and after, run `/memory list` to find any `content unavailable` drift, and ensure the synthetic probe is forgotten if rollback interrupted its cleanup. A snapshot rollback intentionally discards post-snapshot provider writes, while local SQLite may still remember their rows/tombstones.
9. Keep the failed migrated directory and tar archive until the incident is understood.

Any writes made after the snapshot are intentionally lost by this rollback. This is why writers remain paused until acceptance.

## Successful completion and retention

After user acceptance:

1. Resume normal Pi memory writes.
2. Keep monitoring health, Recall, mutation outcomes, disk use, and logs during the agreed observation period.
3. Keep both the untouched pre-upgrade directory and checksummed tar for the approved retention period.
4. Do not retag or move `latest`; keep the live container pinned by digest.
5. Only after separate authorization and retention expiry, delete old/quarantine data and report reclaimed space.
6. Collect representative Chinese, short-query, code-identifier, error-code, and mixed-language `/memory last` score samples. Relevance-threshold design remains a separate task.

## Evidence and reporting requirements

The final report must distinguish:

- backed up but not upgraded;
- upgraded but writes still paused;
- acceptance passed and writes resumed;
- rolled back;
- old backup retained or deleted.

It must include exact image digests, container/mount checks, snapshot checksum, stop/start timestamps, migration duration, acceptance outcomes, rollback status, whether Hindsight was restarted, and any remaining risk. It must not include API keys, LLM endpoint credentials, memory text, or raw database contents.
