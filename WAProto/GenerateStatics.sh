cd "$(dirname "$0")"
pbjs -t static-module --sparse -w esm -o ./index.js ./WAProto.proto
pbts -o ./index.d.ts ./index.js
node ./fix-imports.js
