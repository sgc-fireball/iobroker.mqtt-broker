module.exports = (value) => {
    if (value === undefined || value === null) {
        return 'null';
    }
    if (value === true) {
        return 'true';
    }
    if (value === false) {
        return 'false';
    }
    if (typeof (value) === "object") {
        return JSON.stringify(value);
    }
    if (typeof (value) === "number") {
        return value.toString(10);
    }
    return value.toString('utf8');
};
