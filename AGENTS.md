# Code Writing Rules (non-negotiable)

    Return early — reduce nesting; never go more than 2 levels deep in a function
    Descriptive names — userRepository not userRepo, error not err; no abbreviations
    No comments explaining WHAT — only WHY (hidden constraints, workarounds, non-obvious invariants)
    Result pattern at all boundaries — never throw across package boundaries
    Write the test file before the implementation file — tests are the spec
    Verify third-party APIs in node_modules — do not rely on training data for exact API shapes; libraries change
    No dead code — if something is unused, delete it entirely
    Australian spelling in comments and docs
    750 line hard cap per file — validate after every file save with wc -l; split if exceeded
    500 diff cap per merge

# Don't

    Create oversized files — stay under 750 lines unless justified
    Add TODOs or FIXMEs — fix issues immediately or document in issues
    Create unnecessary files — edit existing files when possible
    Add excessive docstrings — docstrings are concise, practical and only where needed
    Add quality scoring — we don't understand the data well enough yet


# Do

    Read files before modifying — use Read tool to understand existing code
    Follow existing patterns — check similar files (e.g., other scrapers) before implementing
    Run tests after changes — verify nothing is broken
    Keep code simple — direct implementations over complex abstractions
    Add docstrings — but keep them concise (explain what/why, not how)

# Local testing on this machine

    Prefer podman over docker — on this specific machine podman is the container
    runtime to use for any local testing, compose stacks or containerised runs
    (e.g. scripts/podman-run.sh, the infra/ and infra/uat/ compose stacks). The
    scripts fall back to docker, but on this host always drive them with podman —
    set COMPOSE="podman compose" and PODMAN="podman" (or the flatpak-spawn form
    PODMAN="flatpak-spawn --host podman" if running from inside the flatpak).
