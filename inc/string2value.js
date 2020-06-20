module.exports = (str) => {
    if (typeof (str) === "object" && Buffer.isBuffer(str)) {
        str = str.toString('utf8');
    }
    if (typeof (str) === "object" && !!str.type && str.type === "Buffer") {
        str = Buffer.from(str.data).toString('utf8');
    }
    if (str === 'null') {
        return null;
    }
    if (str === 'true') {
        return true;
    }
    if (str === 'false') {
        return false;
    }
    if (str.substr(0, 1) === '{' && str.substr(-1, 1) === '}') {
        return JSON.parse(str);
    }
    if (str.substr(0, 1) === '[' && str.substr(-1, 1) === ']') {
        return JSON.parse(str);
    }
    if (/[+|-][0-9]+\.[0-9]+/.test(str)) {
        return parseFloat(str);
    }
    if (/[+|-][0-9]+/.test(str)) {
        return parseInt(str);
    }
    return str;
};
