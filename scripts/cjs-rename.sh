#!/bin/bash
# Renames dist/electron/**/*.js → .cjs and fixes require paths.
# Needed because root package.json has "type":"module" but Electron
# main process is compiled to CJS by tsconfig.electron.json.
# Using .cjs extension is always CJS regardless of package.json type,
# and avoids creating a dist/electron/package.json that breaks
# Electron's built-in require('electron') resolution.

DIR="dist/electron"

# Fix require paths: .js" → .cjs"  and  .js' → .cjs'
find "$DIR" -name '*.js' -exec sed -i '' 's/\.js")/\.cjs")/g; s/\.js'\'')/\.cjs'\'')/g' {} +

# Also fix .map references
find "$DIR" -name '*.js' -exec sed -i '' 's/\.js\.map/\.cjs\.map/g' {} +

# Rename .js → .cjs
find "$DIR" -name '*.js' -exec bash -c 'mv "$1" "${1%.js}.cjs"' _ {} \;

# Rename .js.map → .cjs.map
find "$DIR" -name '*.js.map' -exec bash -c 'mv "$1" "${1%.js.map}.cjs.map"' _ {} \;
