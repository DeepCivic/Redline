# womblex-ingest — tests
#
# Fakes over the two real seams (object storage + womblex itself) so the whole
# HTTP surface and run lifecycle is exercised without MinIO or the heavy womblex
# dependency present. The compose-level "shards actually land in MinIO" proof is
# the end-to-end sidecar check in scripts/ingest-smoke.sh, not here.
