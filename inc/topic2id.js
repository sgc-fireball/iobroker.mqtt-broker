module.exports = (topic) => {
    let parts = topic.split('.');
    return parts.shift()+'.'+parts.shift()+'/'+parts.join('/');
};
