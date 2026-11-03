# Master Kit: run `just` to list recipes.

set positional-arguments

default:
    @just --list

# Install pinned dependencies
install:
    npm ci

# Dev server on http://localhost:5174 (open it in Windows Chrome)
dev:
    npm run dev

# Open the running dev server in Windows Chrome (from WSL)
open:
    cd /mnt/c && cmd.exe /c start chrome http://localhost:5174

# Unit tests
test:
    npm test

# Typecheck + lint + tests
check:
    npm run typecheck
    npm run lint
    npm test

# Production build into dist/
build:
    npm run build

# Loudness / peak / dynamics / tonal-balance report for a song: just analyze <file> [--json]
analyze *args:
    @node tools/analyze.ts "$@"

# Compare our meters with ffmpeg's ebur128 (no args = EBU synthetic cases; or pass files)
crosscheck *files:
    @node tools/crosscheck.ts "$@"

# Export a master through the Desk in headless Chrome and verify the WAV with ffmpeg: just export <track> [--set JSON] [--bits 16]
export *args:
    @node tools/export.ts "$@"

# Put a mastered WAV back under its video, checking sync before and after: just remux <video> <master.wav> [--out FILE]
remux *args:
    @node tools/remux.ts "$@"

# Check an exported video against its original with ffmpeg (picture untouched, sound in sync): just synccheck <original> <exported>
synccheck *args:
    @node tools/synccheck.ts "$@"

# Prove "Open in Music Shader" sends the master (stand-in shader, byte-compare with the WAV export): just handoffcheck <video>
handoffcheck *args:
    @node tools/handoffcheck.ts "$@"

# Screenshot the Desk at desktop and mobile width: just shot [track] [--play S] [--keys K1,K2] [--name NAME]
shot *args:
    @node tools/shot.ts "$@"

# Render a MUSIC_DIR track through the browser chain in headless Chrome: just render <track> [--set JSON] [--wav FILE] [--live S]
render *args:
    @node tools/render.ts "$@"

# Auto-master several songs alike and write numbered WAVs (with Edges): just album <track>... | --all [--out DIR] [--bits 24|16] [--genre KEY]
album *args:
    @node tools/album.ts "$@"

# Auto-master a MUSIC_DIR track in headless Chrome: just automaster <track> [--ref <track>] [--genre KEY] [--wav FILE] [--session FILE] [--json]
automaster *args:
    @node tools/automaster.ts "$@"
