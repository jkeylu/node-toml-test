import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import * as Path from 'node:path';
import * as fs from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import fetch, { FetchError } from 'node-fetch';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import ora from 'ora';

const DEFAULT_TOML_TEST_BINARY_HOST = 'https://github.com/BurntSushi/toml-test/releases/download';
const HELP_MESSAGE = `Please try the following solutions:
1. Set up a proxy
    export HTTP_PROXY=http://proxy.example.com:1080
    export HTTPS_PROXY=http://proxy.example.com:1080
    export ALL_PROXY=socks5://proxy.example.com:1080
2. Set up a mirror
    export TOML_TEST_BINARY_HOST=https://mirror.example.com/toml-test`;

export class TomlTest {
  get binaryHost() {
    return process.env.TOML_TEST_BINARY_HOST || process.env.npm_config_TOML_TEST_BINARY_HOST || DEFAULT_TOML_TEST_BINARY_HOST;
  }

  get version() {
    const require = createRequire(import.meta.url);
    const pkg = require('./package.json');
    return pkg.tomlTestVersion;
  }

  get platform() {
    if (process.platform === 'win32') {
      return 'windows';
    }
    return process.platform;
  }

  get arch() {
    if (process.arch === 'x64') {
      return 'amd64';
    }
    return process.arch;
  }

  get binaryFilename() {
    let name = `toml-test-v${this.version}-${this.platform}-${this.arch}`;
    if (this.platform === 'windows') {
      name += '.ext';
    }
    return name;
  }

  get compressedFilename() {
    return `${this.binaryFilename}.gz`;
  }

  get url() {
    return new URL(Path.join(this.binaryHost, `v${this.version}/${this.compressedFilename}`));
  }

  get distPath() {
    const __dirname = Path.dirname(fileURLToPath(import.meta.url));
    return Path.join(__dirname, 'dist');
  }

  get binaryFilePath() {
    return Path.join(this.distPath, this.binaryFilename);
  }

  get compressedFilePath() {
    return Path.join(this.distPath, this.compressedFilename);
  }

  async run() {
    await this.ensureBinaryFileExists();

    const argv = [...process.argv];
    argv.shift();
    argv.shift();
    spawn(this.binaryFilePath, argv, { stdio: 'inherit' })
  }

  async ensureBinaryFileExists() {
    if (existsSync(this.binaryFilePath)) {
      return;
    }

    const spinner = ora('Downloading toml-test binary').start();
    try {
      await this.download();
      spinner.succeed('Download tom-test binary success');
    } catch(e) {
      await fs.unlink(this.binaryFilePath).catch(_ => {});
      await fs.unlink(this.compressedFilePath).catch(_ => {});
      if (e instanceof FetchError) {
        spinner.fail('Download toml-test binary failed');
        console.log(HELP_MESSAGE);
      } else {
        console.error(e);
      }
      process.exit(1);
    }
  }

  async download() {
    const res = await this.createFetch(this.url);

    await this.ensureDistExists();
    const ws = createWriteStream(this.compressedFilePath);

    const p = new Promise((resolve, reject) => {
      res.body.on('error', reject);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    res.body.pipe(ws);
    await p;

    await this.decompress();

    await fs.chmod(this.binaryFilePath, 755);
  }

  async ensureDistExists() {
    return await fs.mkdir(this.distPath).catch(_ => {});
  }

  async createFetch(url) {
    const res = await fetch(url.href, { agent: this.getAgent(url), redirect: 'manual' });
    if (res.status === 301 || res.status === 302) {
      const locationURL = new URL(res.headers.get('location'), res.url);
      return this.createFetch(locationURL);
    }
    if (!res.ok) {
      throw new Error(`status: ${res.status}`);
    }
    return res;
  }

  async decompress() {
    const rs = createReadStream(this.compressedFilePath);
    const gunzip = createGunzip();
    const ws = createWriteStream(this.binaryFilePath);

    const p = new Promise((resolve, reject) => {
      rs.on('error', reject);
      gunzip.on('error', reject);
      ws.on('error',reject);
      ws.on('finish', resolve);
    })
    rs.pipe(gunzip).pipe(ws);
    await p;
  }

  getAgent(url) {
    let agent;
    if (url.protocol === 'http:') {
      agent = this.createHttpProxyAgent();
    } else if (url.protocol === 'https:') {
      agent = this.createHttpsProxyAgent();
    }
    if (!agent) {
      agent = this.createAllProxyAgent(url.protocol);
    }
    return agent;
  }

  createHttpProxyAgent() {
    const proxyUrl = process.env.http_proxy || process.env.HTTP_PROXY;
    if (!proxyUrl) {
      return null;
    }
    if (/^http/i.test(proxyUrl)) {
      return new HttpProxyAgent(proxyUrl);
    } else if (/^socks/i.test(proxyUrl)) {
      return new SocksProxyAgent(proxyUrl);
    }
    return null;
  }

  createHttpsProxyAgent() {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
    if (!proxyUrl) {
      return null;
    }
    if (/^http/i.test(proxyUrl)) {
      return new HttpsProxyAgent(proxyUrl);
    } else if (/^socks/i.test(proxyUrl)) {
      return new SocksProxyAgent(proxyUrl);
    }
    return null;
  }

  createAllProxyAgent(protocol) {
    const proxyUrl = process.env.all_proxy || process.env.ALL_PROXY;
    if (!proxyUrl) {
      return null;
    }
    if (/^http/i.test(proxyUrl)) {
      if (protocol === 'http:') {
        return new HttpProxyAgent(proxyUrl);
      } else if (protocol === 'https:') {
        return new HttpsProxyAgent(proxyUrl);
      }
    } else if (/^socks/i.test(proxyUrl)) {
      return new SocksProxyAgent(proxyUrl);
    }
    return null;
  }
}
