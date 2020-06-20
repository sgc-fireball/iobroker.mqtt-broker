module.exports = (id) => {
    let parts = id.split('.');
    return parts.shift() + '.' + parts.shift() + '/' + parts.join('/');
};
