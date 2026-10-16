yarn  pbjs -t static-module --sparse -w commonjs -o ./index.js ./WAProto.proto
yarn pbts -o ./index.d.ts ./index.js
node ./fix-imports.js
