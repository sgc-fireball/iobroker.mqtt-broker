module.exports = (client) => {
    client.hasSubscribed = (topic) => {
        let found = false;
        Object.values(client._subscriptions).forEach((subscription) => {
            if (!found) {
                if (subscription.regex.test(topic)) {
                    found = true;
                }
            }
        });
        return found;
    };
    return client;
};
