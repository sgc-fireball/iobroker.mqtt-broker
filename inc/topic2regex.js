module.exports = (pattern) => {
    if (pattern === '#') {
        return /.*/;
    }

    if (pattern.indexOf('#') !== -1) {
        throw new Error('invalid pattern.');
    }
    if (pattern.indexOf('++') !== -1) {
        throw new Error('invalid pattern.');
    }

    pattern = pattern.replace(/\./g, '\\.');
    pattern = pattern.replace(/\+/, '[^/]+');
    return new RegExp('^' + pattern + '$');
};
