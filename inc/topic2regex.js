module.exports = (pattern) => {
    if (pattern === '#') {
        return new RegExp('^.*$');
    }

    let wildcardPos = pattern.indexOf('#');
    if (wildcardPos !== -1) {
        if (wildcardPos !== pattern.length - 1) {
            throw new Error('Invalid pattern.');
        }
        pattern = pattern.replace(/\$/g, '\\$');
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/#$/, '.*');
        return new RegExp('^' + pattern + '$');
    }

    pattern = pattern.replace(/\$/g, '\\$');
    pattern = pattern.replace(/\./g, '\\.');
    pattern = pattern.replace(/\+/, '[^/]+');
    return new RegExp('^' + pattern + '$');
};
