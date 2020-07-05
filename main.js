'use strict';

const Adapter = require('./lib/Adapter');

if (module.parent) {
    module.exports = (options) => new Adapter(options);
} else {
    new Adapter();
}
