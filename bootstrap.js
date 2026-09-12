const { parseApplyUpdateArgs, runApplyUpdate, prepareUpdateEnvironment } = require("./lib/update");

prepareUpdateEnvironment();

const applyArgs = parseApplyUpdateArgs(process.argv);
if (applyArgs) {
  runApplyUpdate(applyArgs)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(9);
    });
} else {
  require("./main.js");
}
