module.exports = (topic) => {
    return topic.split('/').join('.');
};
