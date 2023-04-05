import type PageLoader from 'next/dist/client/page-loader';
import singletonRouter from 'next/dist/client/router';
import getConfig, { setConfig } from 'next/config';
import EventEmitter from 'eventemitter3';
import { pathnameToRoute } from './helpers';
import { CombinedPages } from './CombinedPages';
import { RemotePages } from './RemotePages';
import {
  NextAppConfig,
  NextAppConfigUrl,
  RemoteContainer,
} from './RemoteContainer';

type EventTypes = 'loadedRemoteRoute' | 'loadedLocalRoute';

/** Remote Container string eg `home@https://example.com/_next/static/chunks/remoteEntry.js` */
export type RemoteString = string;

export type MFClientOptions = {
  mode: 'production' | 'development';
};

/**
 * The main class for Module Federation on the client side in runtime.
 * Instance of this class is a Singleton and stored in `window.mf_client` variable.
 */
export class MFClient {
  /** List of registered remotes */
  remotes: Record<RemoteString, RemoteContainer> = {};
  /** Local & Remote pages sorted in correct order */
  combinedPages: CombinedPages;
  /** Remote pages loader */
  remotePages: RemotePages;
  /** EventEmitter which allows to subscribe on different events */
  events: EventEmitter<EventTypes>;
  /** Original nextjs PageLoader which passed by `patchNextClientPageLoader.js` */
  private _nextPageLoader: PageLoader;

  get webpackSharedScope() {
    // @ts-expect-error can be undefined
    return __webpack_share_scopes__;
  }

  private initialNextConfig: Record<string, any>;
  get nextConfig() {
    return getConfig();
  }

  constructor(nextPageLoader: PageLoader, opts: MFClientOptions) {
    // @ts-expect-error this method will be defined by webpack
    __webpack_init_sharing__('default');

    // @ts-expect-error
    // mark all shared modules from NextJS as loaded
    Object.values(__webpack_share_scopes__?.default || {}).forEach(function (
      moduleVersions: any
    ) {
      if (typeof moduleVersions === 'object') {
        Object.values(moduleVersions).forEach(function (versionData: any) {
          if (typeof versionData === 'object') {
            if (versionData?.from === '_N_E') {
              versionData.loaded = 1;
            }
          }
        });
      }
    });

    this._nextPageLoader = nextPageLoader;
    this.events = new EventEmitter<EventTypes>();

    this.remotePages = this._initRemotePages(opts?.mode);

    const localPagesGetter = (
      this._nextPageLoader as any
    )._getPageListOriginal.bind(this._nextPageLoader);
    this.combinedPages = new CombinedPages(localPagesGetter, this.remotePages);
    // pre-cache new page list (it helps to fix falsy calls of useMFClient({ onRemoteChange }) callback)
    // also it helps to safely use isLocalPathnameSync method
    this.combinedPages.getPageList().catch(() => {});

    this._wrapLoadRoute(nextPageLoader);
    this._wrapWhenEntrypoint(nextPageLoader);

    this.initialNextConfig = getConfig();
    singletonRouter.events.on('routeChangeStart', (pathname) =>
      this.reinitNextAppConfig(pathname)
    );
  }

  /**
   * Init remotes config from `window.__NEXT_DATA__` variable.
   * This variable might be in the following forms:
   *   - { 'home@https://example.com/_next/static/chunks/remoteEntry.js': '/home' }
   *   - { 'home@https://example.com/_next/static/chunks/remoteEntry.js': [ '/home', '/new_home', '/home/link' ] }
   *   - { 'home@https://example.com/_next/static/chunks/remoteEntry.js': { routes: '/home', config: 'https://example.com/nextjs-mf-config' }
   *   - { 'home@https://example.com/_next/static/chunks/remoteEntry.js': { routes: ['/home', '/new_home'], config: 'https://example.com/nextjs-mf-config' }
   *
   * Where `config` is an url, eg. https://example.com/nextjs-mf-config which returns a json with NextJS public runtime config:
   *   { runtimeConfig: { ... }, buildId: '123', assetPrefix: '' }
   */
  private _initRemotePages(mode?: 'production' | 'development') {
    const remotePages = new RemotePages(mode);
    const cfg = (global as any)?.__NEXT_DATA__?.props?.mfRoutes || {};
    Object.keys(cfg).forEach((remoteStr) => {
      const remoteCfg = cfg[remoteStr];
      let routes: string | string[] | undefined;
      let appConfigUrl: string | undefined;

      if (typeof remoteCfg === 'string' || Array.isArray(remoteCfg)) {
        routes = remoteCfg;
      } else if (typeof remoteCfg === 'object') {
        routes = remoteCfg.routes;
        if (typeof remoteCfg.config === 'string') {
          appConfigUrl = remoteCfg.config;
        }
      }

      const remote = this.registerRemote(remoteStr, appConfigUrl);
      if (routes) remotePages.addRoutes(routes, remote);
    });

    return remotePages;
  }

  /**
   * This method returns sorted list of local and federated pages.
   *
   * `patchNextClientPageLoader` change vanilla PageLoader.getPageList() method:
   *   - exposes vanilla implementation as _getPageListOriginal()
   *   - and PageLoader.getPageList() starting call this method under the hood
   */
  async getPageList() {
    return this.combinedPages.getPageList();
  }

  /**
   * Check that current browser pathname is served by federated remotes.
   *
   * Eg. if pathname `/shop/nodkz/product123?ok=456` and pageListFederated is ['/shop/nodkz/[...mee]']
   *     then this method will match federated dynamic route and return true.
   *
   * PS. This method MUST BE SYNC because it is used
   *   - by DevHmrFixInvalidPongPlugin (fix HMR page reloads in dev mode)
   *   - also it's used in useFMClient hook
   */
  isFederatedPathname(dirtyPathname: string): boolean {
    const cleanPathname = (dirtyPathname || '').split('?')[0];
    if (this.combinedPages.isLocalPathnameSync(cleanPathname)) {
      return false;
    }
    return !!this.remotePages.routeToRemote(cleanPathname);
  }

  /**
   * Add remote entry to remotes registry of MFClient.
   * This RemoteContainer will be used for loading remote pages.
   *
   * @remoteStr string -  eg. `home@https://example.com/_next/static/chunks/remoteEntry.js`
   */
  registerRemote(
    remoteStr: RemoteString,
    appConfig?: NextAppConfig | NextAppConfigUrl
  ) {
    const remote = RemoteContainer.createSingleton(remoteStr, appConfig);
    this.remotes[remote.global] = remote;
    return remote;
  }

  /**
   * Convert browser pathname to NextJS route.
   *
   *   /shop/products/123 -> /shop/products/[...id]
   *
   * For regular pages logic is simple (just match exact name).
   * But for dynamic routes it's quite complicated - page list must be in specific order.
   */
  async pathnameToRoute(cleanPathname: string): Promise<string | undefined> {
    const routes = await this.getPageList();
    return pathnameToRoute(cleanPathname, routes);
  }

  /**
   * This method patch routeLoader.loadRoute() in runtime (on bootstrap).
   * During the build it's quite complicated to do.
   */
  private _wrapLoadRoute(nextPageLoader: PageLoader) {
    if (!nextPageLoader?.routeLoader?.loadRoute) {
      throw new Error(
        '[nextjs-mf] Cannot wrap `pageLoader.routeLoader.loadRoute()` with custom logic.'
      );
    }

    const routeLoader =
      nextPageLoader.routeLoader as PageLoader['routeLoader'] & {
        // eslint-disable-next-line @typescript-eslint/ban-types
        _loadRouteOriginal: Function;
      };

    // if _loadRouteOriginal does not initialized then take original loadRoute method
    if (!routeLoader._loadRouteOriginal) {
      routeLoader._loadRouteOriginal = routeLoader.loadRoute.bind(routeLoader);
    }

    // replace loadRoute logic
    routeLoader.loadRoute = async (route, prefetch) => {
      let routeInfo;
      if (await this.combinedPages.isLocalRoute(route)) {
        routeInfo = await routeLoader._loadRouteOriginal(route);
        this.events.emit('loadedLocalRoute', routeInfo, prefetch);
      } else {
        try {
          routeInfo = await this.remotePages.getRouteInfo(route);
          this.events.emit(
            'loadedRemoteRoute',
            routeInfo,
            prefetch,
            this.remotePages.routeToRemote(route)
          );
        } catch (e) {
          // as fallback try to use original loadRoute for keeping nextjs logic for routes load errors
          routeInfo = await routeLoader._loadRouteOriginal(route);
        }
      }
      return routeInfo;
    };
  }

  /**
   * This method patch routeLoader.whenEntrypoint() in runtime (on bootstrap).
   * During the build it's quite complicated to do.
   */
  private _wrapWhenEntrypoint(nextPageLoader: PageLoader) {
    if (!nextPageLoader.routeLoader?.whenEntrypoint) {
      throw new Error(
        '[nextjs-mf] Cannot wrap `pageLoader.routeLoader.whenEntrypoint()` with custom logic.'
      );
    }

    const routeLoader =
      nextPageLoader.routeLoader as PageLoader['routeLoader'] & {
        // eslint-disable-next-line @typescript-eslint/ban-types
        _whenEntrypointOriginal: Function;
      };

    // if _whenEntrypointOriginal does not initialized then take original loadRoute method
    if (!routeLoader._whenEntrypointOriginal) {
      routeLoader._whenEntrypointOriginal =
        routeLoader.whenEntrypoint.bind(routeLoader);
    }

    // replace routeLoader.whenEntrypoint logic
    routeLoader.whenEntrypoint = async (route: string) => {
      if (route === '/_error' || route === '/404') {
        try {
          let route = await this.pathnameToRoute(window.location.pathname);
          if (!route) {
            // if route not found then try to load all non-downloaded remoteEntries
            // and try to find route again
            // we MUST load routes serially because of webpack chunks loading
            // (in parallel mode it starts to load similar chunks several times)
            for (const key in this.remotes) {
              const remote = this.remotes[key];
              if (!remote.isLoaded()) {
                try {
                  await remote.getContainer();
                  await this.remotePages.loadRemotePageMap(remote);
                } catch (e) {
                  // do nothing
                }
              }
            }
            route = await this.pathnameToRoute(window.location.pathname);
          }
          if (route) {
            this.reinitNextAppConfig(window.location.pathname);

            // TODO: fix router properties for the first page load of federated page http://localhost:3000/shop/products/B
            console.warn('replace entrypoint /_error by', route);
            const routeInfo = await this.remotePages.getRouteInfo(route);
            this.events.emit(
              'loadedRemoteRoute',
              routeInfo,
              false,
              this.remotePages.routeToRemote(route)
            );
            return routeInfo;
          }
        } catch (e) {
          // do nothing, load original entrypoint
        }
      }
      const routeInfo = await routeLoader._whenEntrypointOriginal(route);
      return routeInfo;
    };
  }

  /**
   * This method set public NextJS config (publicRuntimeConfig) for any remote or host application.
   * This config is global for browser and currently opened pages may use it.
   *
   * For example if we open `storage` service as host app and then switch to `tickets` service
   * then we have to reinit this config with tickets' publicRuntimeConfig variables. Otherwise tickets pages
   * will connect to storage's GraphQL server.
   */
  reinitNextAppConfig(dirtyPathname: string) {
    const pathname = dirtyPathname?.split('?')[0];
    if (this.combinedPages.isLocalPathnameSync(pathname)) {
      // set config from local nextjs app
      setConfig(this.initialNextConfig);
    } else {
      const remote = this.remotePages.routeToRemote(pathname);
      if (remote) {
        // set config for remote nextjs app
        const remoteAppConfig = remote?.appConfig?.runtimeConfig;
        if (remoteAppConfig) {
          setConfig({
            serverRuntimeConfig: {},
            publicRuntimeConfig: remoteAppConfig,
          });
        }
      }
    }
  }
}
