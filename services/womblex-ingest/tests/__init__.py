# womblex-ingest — tests
#
# Fakes over the two real seams (object storage + womblex itself) so the whole
# HTTP surface and run lifecycle is exercised without MinIO or the heavy womblex
# dependency present. The compose-level "shards actually land in MinIO" proof is
# the Thread 3 exit test in scripts/thread-03-smoke.sh, not here.
