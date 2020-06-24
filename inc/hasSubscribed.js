module.exports = (client) => {
    if (!client.hasSubscribed) {
        client.hasSubscribed = (topic) => {
            if (client._subscriptions.hasOwnProperty('#')) {
                return true;
            }
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
    }
    return client;
};
