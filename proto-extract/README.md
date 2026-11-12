# Proto Extract

Derived initially from `whatseow`'s proto extract, this version generates a predictable diff friendly protobuf. It also does not rely on a hardcoded set of modules to look for but finds all proto modules on its own and extracts the proto from there.

Thanks to [wppconnect-team](https://github.com/wppconnect-team) for the script update to make it work with the latest version of whatsapp.

## Usage
1. Install dependencies with `npm install`
2. `npm start`
3. The script will update `../WAProto/WAProto.proto` (except if something is broken)
