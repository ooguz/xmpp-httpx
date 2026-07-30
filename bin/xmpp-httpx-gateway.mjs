#!/usr/bin/env node
// Thin shebang wrapper: tsc emits no shebang, and keeping one here means the
// compiled CLI stays an ordinary module (importable, testable).
import "../dist/cli/main.js";
