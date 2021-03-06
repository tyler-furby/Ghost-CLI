'use strict';

const fs = require('fs-extra');
const os = require('os');
const dns = require('dns');
const url = require('url');
const path = require('path');
const execa = require('execa');
const Promise = require('bluebird');
const template = require('lodash/template');

const cli = require('../../lib');

class NginxExtension extends cli.Extension {
    setup(cmd, argv) {
        // ghost setup --local, skip
        if (argv.local) {
            return;
        }

        cmd.addStage('nginx', this.setupNginx.bind(this), null, 'Nginx');
        cmd.addStage('ssl', this.setupSSL.bind(this), 'nginx', 'SSL');
    }

    setupNginx(argv, ctx, task) {
        if (!this.isSupported()) {
            this.ui.log('Nginx is not installed. Skipping Nginx setup.', 'yellow');
            return task.skip();
        }

        let parsedUrl = url.parse(ctx.instance.config.get('url'));

        if (parsedUrl.port) {
            this.ui.log('Your url contains a port. Skipping Nginx setup.', 'yellow');
            return task.skip();
        }

        let confFile = `${parsedUrl.hostname}.conf`;

        if (fs.existsSync(`/etc/nginx/sites-available/${confFile}`)) {
            this.ui.log('Nginx configuration already found for this url. Skipping Nginx setup.', 'yellow');
            return task.skip();
        }

        let conf = template(fs.readFileSync(path.join(__dirname, 'templates', 'nginx.conf'), 'utf8'));

        let rootPath = path.resolve(ctx.instance.dir, 'system', 'nginx-root');

        let generatedConfig = conf({
            url: parsedUrl.hostname,
            webroot: rootPath,
            location: parsedUrl.pathname !== '/' ? `^~ ${parsedUrl.pathname}` : '/',
            port: ctx.instance.config.get('server.port')
        });

        return ctx.instance.template(
            generatedConfig,
            'nginx config',
            confFile,
            '/etc/nginx/sites-available'
        ).then(() => {
            return this.ui.sudo(`ln -sf /etc/nginx/sites-available/${confFile} /etc/nginx/sites-enabled/${confFile}`);
        }).then(() => this.restartNginx());
    }

    setupSSL(argv, ctx, task) {
        let parsedUrl = url.parse(ctx.instance.config.get('url'));
        let confFile = `${parsedUrl.hostname}-ssl.conf`;

        if (fs.existsSync(`/etc/nginx/sites-available/${confFile}`)) {
            this.ui.log('SSL has already been set up, skipping', 'yellow');
            return task.skip();
        }

        if (!argv.prompt && !argv.sslemail) {
            this.ui.log('SSL email must be provided via the --sslemail option, skipping SSL setup', 'yellow');
            return task.skip();
        }

        if (!fs.existsSync(`/etc/nginx/sites-available/${parsedUrl.hostname}.conf`)) {
            if (ctx.single) {
                this.ui.log('Nginx config file does not exist, skipping SSL setup', 'yellow');
            }

            return task.skip();
        }

        let rootPath = path.resolve(ctx.instance.dir, 'system', 'nginx-root');
        let dhparamFile = path.join(ctx.instance.dir, 'system', 'files', 'dhparam.pem');

        return this.ui.listr([{
            title: 'Checking DNS resolution',
            task: (ctx) => {
                return Promise.fromNode(cb => dns.lookup(parsedUrl.hostname, {family: 4}, cb)).catch((error) => {
                    if (error.code !== 'ENOTFOUND') {
                        // Some other error
                        return Promise.reject(error);
                    }

                    // DNS entry has not populated yet, log an error and skip rest of the
                    // ssl configuration
                    let text = [
                        'Uh-oh! It looks like your domain isn\'t set up correctly yet.',
                        'Because of this, SSL setup won\'t work correctly. Once you\'ve set up your domain',
                        'and pointed it at this server\'s IP, try running `ghost setup ssl` again.'
                    ];

                    this.ui.log(text.join(' '), 'yellow');
                    ctx.dnsfail = true;
                });
            }
        }, {
            title: 'Getting additional configuration',
            skip: (ctx) => ctx.dnsfail,
            task: () => {
                let promise;

                if (argv.sslemail) {
                    promise = Promise.resolve(argv.sslemail);
                } else {
                    promise = this.ui.prompt({
                        name: 'email',
                        type: 'input',
                        message: 'Enter your email (used for Let\'s Encrypt notifications)',
                        validate: value => Boolean(value) || 'You must supply an email'
                    }).then(answer => { argv.sslemail = answer.email; });
                }

                return promise;
            }
        }, {
            title: 'Getting SSL Certificate from Let\'s Encrypt',
            skip: (ctx) => ctx.dnsfail,
            task: () => {
                return execa.shell('curl https://get.acme.sh | sh').then(() => {
                    let acmeScriptPath = path.join(os.homedir(), '.acme.sh', 'acme.sh');

                    let cmd = `${acmeScriptPath} --issue --domain ${parsedUrl.hostname} --webroot ${rootPath} ` +
                        `--accountemail ${argv.sslemail}${argv.sslstaging ? ' --staging' : ''}`;

                    return execa.shell(cmd);
                }).catch((error) => {
                    // Certs have been generated before, skip
                    if (!error.stdout.match(/Skip/)) {
                        return Promise.reject(new cli.errors.ProcessError(error));
                    }
                });
            }
        }, {
            title: 'Generating Encryption Key (may take a few minutes)',
            skip: (ctx) => ctx.dnsfail,
            task: () => {
                return execa.shell(`openssl dhparam -out ${dhparamFile} 2048`)
                    .catch((error) => Promise.reject(new cli.errors.ProcessError(error)));
            }
        }, {
            title: 'Generating SSL security headers',
            skip: (ctx) => ctx.dnsfail,
            task: (ctx) => {
                let sslParamsConf = template(fs.readFileSync(path.join(__dirname, 'templates', 'ssl-params.conf'), 'utf8'));
                return ctx.instance.template(
                    sslParamsConf({ dhparam: dhparamFile }),
                    'ssl security parameters',
                    'ssl-params.conf'
                );
            }
        }, {
            title: 'Generating SSL configuration',
            skip: (ctx) => ctx.dnsfail,
            task: (ctx) => {
                let acmeFolder = path.join(os.homedir(), '.acme.sh', parsedUrl.hostname);
                let sslConf = template(fs.readFileSync(path.join(__dirname, 'templates', 'nginx-ssl.conf'), 'utf8'));
                let generatedSslConfig = sslConf({
                    url: parsedUrl.hostname,
                    webroot: rootPath,
                    fullchain: path.join(acmeFolder, 'fullchain.cer'),
                    privkey: path.join(acmeFolder, `${parsedUrl.hostname}.key`),
                    sslparams: path.join(ctx.instance.dir, 'system', 'files', 'ssl-params.conf'),
                    location: parsedUrl.pathname !== '/' ? `^~ ${parsedUrl.pathname}` : '/',
                    port: ctx.instance.config.get('server.port')
                });

                return ctx.instance.template(
                    generatedSslConfig,
                    'ssl config',
                    confFile,
                    '/etc/nginx/sites-available'
                ).then(
                    () => this.ui.sudo(`ln -sf /etc/nginx/sites-available/${confFile} /etc/nginx/sites-enabled/${confFile}`)
                );
            }
        }, {
            title: 'Restarting Nginx',
            skip: (ctx) => ctx.dnsfail,
            task: () => this.restartNginx()
        }], false);
    }

    uninstall(instance) {
        let parsedUrl = url.parse(instance.config.get('url'));
        let confFile = `${parsedUrl.hostname}.conf`;
        let sslConfFile = `${parsedUrl.hostname}-ssl.conf`;

        let promises = [];

        if (fs.existsSync(`/etc/nginx/sites-available/${confFile}`)) {
            // Nginx config exists, remove it
            promises.push(
                Promise.all([
                    this.ui.sudo(`rm -f /etc/nginx/sites-available/${confFile}`),
                    this.ui.sudo(`rm -f /etc/nginx/sites-enabled/${confFile}`)
                ]).catch(
                    () => Promise.reject(new cli.errors.SystemError('Nginx config file link could not be removed, you will need to do this manually.'))
                )
            );
        }

        if (fs.existsSync(`/etc/nginx/sites-available/${sslConfFile}`)) {
            // SSL config exists, remove it
            promises.push(
                Promise.all([
                    this.ui.sudo(`rm -f /etc/nginx/sites-available/${sslConfFile}`),
                    this.ui.sudo(`rm -f /etc/nginx/sites-enabled/${sslConfFile}`)
                ]).catch(
                    () => Promise.reject(new cli.errors.SystemError('SSL config file link could not be removed, you will need to do this manually.'))
                )
            );
        }

        if (!promises.length) {
            return Promise.resolve();
        }

        return Promise.all(promises).then(() => this.restartNginx());
    }

    restartNginx() {
        return this.ui.sudo('service nginx restart')
            .catch((error) => Promise.reject(new cli.errors.ProcessError(error)));
    }

    isSupported() {
        try {
            execa.shellSync('dpkg -l | grep nginx', {stdio: 'ignore'});
            return true;
        } catch (e) {
            return false;
        }
    }
}

module.exports = NginxExtension;
