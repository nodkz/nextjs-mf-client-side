import EventEmitter from 'eventemitter3';
import { injectScript } from '../utils';

type EventTypes = 'loadStart' | 'loadComplete' | 'loadError';

export type WebpackRemoteContainer = {
  get(modulePath: ModulePath): () => any;
};
export type NextRoute = string;
export type ModulePath = string;
export type RemoteData = {
  global: string;
  url: string;
};
export type PageMap = Record<NextRoute, ModulePath>;

export type NextAppConfigUrl = string;
export type NextAppConfig = {
  buildId?: string;
  assetPrefix?: string;
  /** List of public runtime variables @see https://nextjs.org/docs/api-reference/next.config.js/runtime-configuration */
  runtimeConfig?: Record<string, any>;
};

type NextAppConfigLazy = () => Promise<NextAppConfig>;

/**
 * This is a Lazy loader of webpack remote container with some NextJS-specific helper methods.
 *
 * It provides the ability to register remote, and load & init it on the first use.
 */
export class RemoteContainer {
  global: string;
  url: string;
  container: WebpackRemoteContainer | undefined;
  pageMap: PageMap | undefined;
  appConfig?: NextAppConfig | null;
  private appConfigLazy?: NextAppConfigLazy;
  error?: Error;
  events: EventEmitter<EventTypes>;
  private _loading: any;

  static instances: Record<string, RemoteContainer> = {};

  /**
   * Create or reuse existed remote entry.
   *
   * Be careful, Singleton pattern does not work well in webpack builds,
   * because one module may be copied between different chunks. In such a way
   * you obtain several lists of instances.
   */
  static createSingleton(
    remote: string | RemoteData,
    appConfig?: NextAppConfig | NextAppConfigUrl
  ): RemoteContainer {
    let data: RemoteData | undefined;
    if (typeof remote === 'string') {
      const [global, url] = remote.split('@');
      data = { global, url };
    } else if (remote?.global && remote?.url) {
      data = { global: remote.global, url: remote.url };
    }

    if (!data) {
      console.error(
        `Cannot init RemoteContainer with following data`,
        RemoteContainer
      );
      throw Error(
        '[nextjs-mf] RemoteContainer.createSingleton(remote) accepts string "shop@http://example.com/_next/static/chunks/remoteEntry.js" OR object { global: "shop", url: "http://example.com/_next/static/chunks/remoteEntry.js"}'
      );
    }

    let container: RemoteContainer;
    if (this.instances[data.global]) {
      container = this.instances[data.global];
    } else {
      container = new RemoteContainer(data, appConfig);
      this.instances[data.global] = container;
    }

    return container;
  }

  constructor(opts: RemoteData, appConfig?: NextAppConfig | NextAppConfigUrl) {
    this.global = opts.global;
    this.url = opts.url;
    this.events = new EventEmitter<EventTypes>();

    if (appConfig) {
      if (typeof appConfig === 'string') {
        this.appConfigLazy = () => {
          return fetch(appConfig).then((res) => res.json());
        };
      } else {
        this.appConfig = appConfig;
      }
    }
  }

  /**
   * Check is the current remoteEntry.js loaded or not
   */
  isLoaded(): boolean {
    return !!this.container;
  }

  /**
   * Returns initialized webpack RemoteContainer.
   * If its' script does not loaded - then load & init it firstly.
   */
  async getContainer(): Promise<WebpackRemoteContainer> {
    if (this.container) {
      return this.container;
    }

    this.events.emit('loadStart', this);

    try {
      const _url = new URL(this.url);
      _url.searchParams.set('t', Date.now().toString());

      // load in parallel remoteEntry and next app config
      // for multiple `getContainer` call load data one time
      this._loading =
        this._loading ||
        Promise.all([
          injectScript({
            global: this.global,
            url: _url.href,
          }),
          this.getAppConfig(),
        ]);
      const [container] = await this._loading;

      if (container) {
        this.container = container;
        this.events.emit('loadComplete', this);
        return container;
      }

      throw Error(`[nextjs-mf] Remote container ${this.url} is empty`);
    } catch (e) {
      this.error = e;
      this.events.emit('loadError', e.message, this);
      throw e;
    }
  }

  async getAppConfig(): Promise<NextAppConfig | null> {
    if (this.appConfig || this.appConfig === null) {
      return this.appConfig;
    }

    if (this.appConfigLazy) {
      let cfg: NextAppConfig | null = null;
      try {
        cfg = await this.appConfigLazy();
      } catch (e) {
        console.error(
          `[nextjs-mf] Cannot load next app config for remote ${this.global}`,
          e
        );
      }
      this.appConfig = cfg;
      return cfg;
    }

    return null;
  }

  /**
   * Return remote module from container.
   * If you provide `exportName` it automatically return exact property value from module.
   *
   * @example
   *   remote.getModule('./pages/index', 'default')
   */
  async getModule(modulePath: string, exportName?: string) {
    const container = await this.getContainer();
    const modFactory = await container.get(modulePath);
    if (!modFactory) return undefined;
    const mod = modFactory();
    if (exportName) {
      return mod && typeof mod === 'object' ? mod[exportName] : undefined;
    } else {
      return mod;
    }
  }

  /**
   * Retrieve registered nextjs' routes from remote app
   */
  async getPageMap(): Promise<PageMap | undefined> {
    if (this.pageMap) {
      return this.pageMap;
    }

    const pageMap = await this.getModule('./pages-map-v2', 'default');
    if (pageMap) {
      this.pageMap = pageMap;
    } else {
      this.pageMap = {};
      console.warn(
        `[nextjs-mf] Container ${this.global} does not expose "./pages-map-v2" module.`
      );
    }

    return this.pageMap;
  }
}
