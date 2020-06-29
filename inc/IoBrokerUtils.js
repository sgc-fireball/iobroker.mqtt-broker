class IoBrokerUtils {

    constructor(adapter) {
        this.adapter = adapter || null;
    }

    setAdapter(adapter) {
        this.adapter = adapter;
        return this;
    }

    getSecret() {
        return new Promise((resolve, reject) => {
            let secret = 'Zgfr56gFe87jJOM';
            if (this.adapter) {
                this.adapter.getForeignObject('system.meta.uuid', (err, oUuid) => {
                    secret = ((obj || {}).native || {}).secret || secret;
                    resolve(secret);
                });
                return;
            }
            return resolve(secret);
        });
    }

    encrypt(value) {
        return new Promise((resolve, reject) => {
            this.getSecret()
                .then((key) => {
                    let result = '';
                    for (let i = 0; i < value.length; ++i) {
                        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
                    }
                    resolve(result);
                })
                .catch(e => reject(e));
        });
    }

    decrypt(value) {
        return this.encrypt(value);
    }

    checkCredentials(username, password) {
        return new Promise((resolve, reject) => {
            username = username.replace(/\s/g, '_');
            this.adapter.getObject(
                'system.user.' + username,
                (err, obj) => {
                    if (err || !obj) {
                        return reject(err);
                    }

                    if (!obj.common.enable) {
                        return reject('Invalid credentials. User is disabled.');
                    }

                    /** @see https://github.com/ioBroker/ioBroker.js-controller/blob/3a3cda9ba615ed14a9a128de4379f5589f4f4b0f/lib/password.js#L72 */
                    const hash = obj.common.password;
                    const key = hash.split('$');
                    if (key.length !== 4 || !key[2] || !key[3]) {
                        return reject('Invalid credentials. Unknown password type.');
                    }
                    if (key[0] !== 'pbkdf2') {
                        return reject('Invalid credentials. Invalid password type.');
                    }

                    const salt = key[3] || crypto.randomBytes(16).toString('hex');
                    const iterations = parseInt(key[1], 10) || 10000;

                    crypto.pbkdf2(
                        password,
                        salt,
                        iterations,
                        256,
                        'sha256',
                        (err, key) => {
                            if (err || !key) {
                                return reject('Invalid credentials. '+e.toString());
                            }

                            if (hash === `pbkdf2$${iterations}$${key.toString('hex')}$${salt}`) {
                                return resolve();
                            }
                            return reject('Invalid credentials. Invalid Password.');
                        }
                    );
                }
            );
        });
    }

}

module.exports = IoBrokerUtils;
