import {Application, Component, CoreBindings, inject} from '@loopback/core';
import * as glob from 'glob';
import * as path from 'path';
import * as _ from 'lodash';
import {RestBindings, RouterSpec} from '@loopback/rest';
import {PathObject, PathsObject, ParameterObject, ParameterLocation} from '@loopback/openapi-v3';
import {Request, Response, NextFunction} from 'express';
import {OAI3Keys} from '@loopback/openapi-v3/dist/keys';
import {Injection, MetadataInspector, MethodDecoratorFactory} from '@loopback/context';
import {MetadataAccessor, MetadataMap} from '@loopback/metadata';
import * as async from 'async';
import * as util from 'util';
import * as resolve from 'resolve-pkg';
import * as VError from 'verror';
import {createVersionsController} from './versions.controller';
import {AUTHENTICATION_METADATA_KEY, AuthenticationMetadata} from '@labshare/services-auth';

const {getPackageDependencies, getPackageName, getPackageManifest , getPackageLscSettings}  = require('../api/utils');
const METHODS_KEY = MetadataAccessor.create<Injection, MethodDecorator>('inject:methods');
const PATH_PARAMS_REGEX = /[\/?]:(.*?)(?![^\/])/g;

export class LegacyLoaderComponent implements Component {

  packageManifests: any[] = [];
  mainDir: string;
  apiFilePattern: string;

  constructor(@inject(CoreBindings.APPLICATION_INSTANCE) private application: Application) {
    const config = this.application.options;
    this.mainDir = config?.services?.main || process.cwd();
    const manifest = getPackageManifest(this.mainDir);
    const lscSettings = getPackageLscSettings(manifest);
    this.apiFilePattern = lscSettings?.apiPattern ||  config?.services?.pattern || '{src/api,api}/*.js';
    const mountPoints = config?.services?.mountPoints || [''];
    
    this.packageManifests.push(manifest);
    const packageDependencies = lscSettings?.packageDependencies || getPackageDependencies(manifest);

    for(const mountPoint of mountPoints) {
      // mount legacy API routes from the current module
      this.mountLegacyApiDirectory(this.application, this.mainDir, mountPoint);

      // mount legacy API routes from package dependencies
      for (const dependencyObj of packageDependencies) {
        const dependency = _.isString(dependencyObj)?dependencyObj:dependencyObj.key;
        const dependencyPath = resolve(dependency, {cwd: this.mainDir});
        if (!dependencyPath) {
          throw new Error(`Dependency: "${dependency}" required by "${this.mainDir}" could not be found. Is it installed?`);
        }
        this.mountLegacyApiDirectory(this.application, dependencyPath, mountPoint);
      }
    }
    // add controller for package versions
    const versionsController = createVersionsController(this.packageManifests);
    this.application.controller(versionsController);
  }

  private mountLegacyApiDirectory(application: Application, directory: string, mountPoint: string) {
    const serviceModulePaths = glob.sync(this.apiFilePattern, {cwd: directory}).map(file => {
      return path.resolve(directory, file);
    });

    const manifest = getPackageManifest(directory);
    if (!manifest) {
      return;
    }

    if (!_.find(this.packageManifests, {'name': manifest.name})) {
      this.packageManifests.push(manifest);
    }
    const packageName = getPackageName(manifest);

    const serviceRoutes = getServiceRoutes(serviceModulePaths);

    // loop over discovered api modules
    for (const service in serviceRoutes) {
      const routes = serviceRoutes[service];
      const controllerClassName = `${getControllerPrefix(mountPoint, packageName)}${service}Controller`;
      const middlewareSpecs: any = {}; // an key-value object with keys being route handler names and values the handler function themselves
      const pathsSpecs: PathsObject = {}; // LB4 object to add to class to specify route / handler mapping
      // loop over routes defined in the module
      for (const route of routes) {
        try {
          const httpMethods = _.isArray(route.httpMethod) ? route.httpMethod : [route.httpMethod];
          for (const httpMethod of httpMethods) {
            const handlerName =
              httpMethod.toLowerCase() +
              route.path
                .replace(/\/:/g, '_')
                .replace(/\//g, '_')
                .replace(/-/g, '_')
                .replace('?', '');
            middlewareSpecs[handlerName] = {
              handler: route.middleware,
              auth: {
                scope: route.scope,
                accessLevel: route.accessLevel
              }
            };
            // prefix each path with mount path and lower case it
            route.path = pathToLowerCase(`${mountPoint}/${packageName}${route.path}`);
            appendPath(pathsSpecs, route, controllerClassName, handlerName);
          }
        } catch (err) {
          throw new VError(err, `Error loading route ${JSON.stringify(route.httpMethod)} : ${route.path}.`);
        }
      }
      try {
        const controllerSpecs: RouterSpec = {paths: pathsSpecs};
        const controllerClassDefinition = getControllerClassDefinition(controllerClassName, Object.keys(middlewareSpecs));
        const defineNewController = new Function('middlewareRunner', 'middlewareSpecs', controllerClassDefinition);
        const controllerClass = defineNewController(middlewareRunnerPromise, middlewareSpecs);

        // Add metadata for mapping HTTP routes to controller class functions
        MetadataInspector.defineMetadata(OAI3Keys.CONTROLLER_SPEC_KEY.key, controllerSpecs, controllerClass);
        defineAuthMetadata(controllerClass, middlewareSpecs);

        const injectionSpecs = getControllerInjectionSpecs(controllerClass);
        // Add metadata for injecting HTTP Request and Response objects into controller class
        MetadataInspector.defineMetadata<MetadataMap<Readonly<Injection>[]>>(METHODS_KEY, injectionSpecs, controllerClass);

        // add controller to the LB4 application
        application.controller(controllerClass);
      }
      catch (err) {
        throw new VError(err, `Error registering module ${service} as LoopBack controller.`);
      }
    }
  }
}

/**
 * Runs middleware function or a collection of functions
 * @param middleware middleware which can be either a single function or an array of functions
 * @param req HTTP request object
 * @param res HTTP response object
 * @param cb callback function
 */
function middlewareRunner(middleware: any, req: Request, res: Response, cb: NextFunction) {
  // apply request and response arguments to each middleware function and run them in sequence
  async.applyEachSeries(middleware, req, res, cb);
}

const middlewareRunnerPromise = util.promisify(middlewareRunner);

function getServiceRoutes(serviceModulePaths: string[]) {
  return _.reduce(
    serviceModulePaths,
    (result, value, key) => {
      const module = require(value);
      const routes = getRoutes(module);
      if (_.isEmpty(routes)) {
        return result;
      }
      let serviceName;
      if (!_.isFunction(module.constructor)) {
        serviceName = module.constructor.name;
      } else {
        const matches = value.match(/[^\\\/]+(?=\.[\w]+$)|[^\\\/]+$/);
        if (!matches) {
          throw new Error(`Could not determine service name for module ${value}.`);
        }
        serviceName = _.startCase(matches[0]).replace(/ /g, '');
      }
      result[serviceName] = routes;
      return result;
    },
    {} as any
  );
}

/**
 * @description Retrieves the list of routes from the given module.
 * @param {Module} serviceModule - A NodeJS module that defines routes
 * @returns {Array} - A list of route objects or an empty array
 * @private
 */
function getRoutes(serviceModule: any): LegacyRoute[] {
  if (_.isFunction(serviceModule)) {
    // support revealing module pattern
    serviceModule = serviceModule();
  }

  const routes = serviceModule.Routes || serviceModule.routes || [];

  // Ensure modifications of the route properties do not mutate the original module
  const routesCopy = _.cloneDeep(routes);
  // Ensure that all middleware is an array rather than a function
  for (const route of routesCopy) {
    if (_.isFunction(route.middleware)) {
      route.middleware = [route.middleware];
    }
  }
  return routesCopy;
}

/**
 * Returns a string with controller class definition
 * @param controllerClassName - a name to be given to controller class
 * @param handlerNames - handler function name
 */
function getControllerClassDefinition(controllerClassName: string, handlerNames: string[]): string {
  let handlers = '';
  for (const handlerName of handlerNames) {
    handlers =
      handlers +
      `async ${handlerName}() {return await middlewareRunner(middlewareSpecs['${handlerName}'].handler, this.request, this.response);}\n`;
  }
  return `return class ${controllerClassName} {
    constructor(request, response) {
       this.request = request;
       this.response = response;
    };
    
    ${handlers}      
  }`;
}

/**
 * Appends a new LB4 PathObject to PathObjects collection
 * @param pathsObject - LB4 PathObjects collection to append new item to
 * @param route - HTTP route for new PathObject
 * @param controllerName - controller class name
 * @param handlerName - handler function name to map HTTP route to
 */
function appendPath(pathsObject: PathsObject, route: LegacyRoute, controllerName: string, handlerName: string) {
  const lb4Path = route.path.replace(PATH_PARAMS_REGEX, (substring: string): string => {
    return `/{${_.trimStart(substring.replace('?', ''), '/:')}}`;
  });
  let pathObject: PathObject;
  if (!pathsObject[lb4Path]) {
    pathObject = {};
    pathsObject[lb4Path] = pathObject;
  } else {
    pathObject = pathsObject[lb4Path];
  }

  const httpMethods = _.isArray(route.httpMethod) ? route.httpMethod : [route.httpMethod];
  for (const httpMethod of httpMethods) {
    pathObject[httpMethod] = {
      responses: {},
      'x-operation-name': handlerName,
      'x-controller-name': controllerName,
      operationId: `${controllerName}.${handlerName}`
    };
    const params = getPathParams(route.path);
    if (!_.isEmpty(params)) {
      pathObject[httpMethod].parameters = params;
    }
  }
}

/**
 * Parses express.js route path and returns an array of LB4 ParameterObjects[] corresponding to found path parameters
 * @param routePath
 */
function getPathParams(routePath: string): ParameterObject[] {
  const matches = routePath.match(PATH_PARAMS_REGEX);
  return _.map(matches, match => {
    let required = true;
    if (match.endsWith('?')) {
      required = false;
    }
    return {
      name: _.trimStart(match.replace('?', ''), ':/'),
      in: 'path' as ParameterLocation,
      schema: {
        type: 'string'
      },
      required
    };
  });
}

/**
 * Returns LB4 MetadataMap to be used for injecting Request and Response objects to dynamically defined controller classes
 * @param target - controller class object
 */
function getControllerInjectionSpecs(target: Object): MetadataMap<Readonly<Injection>[]> {
  return {
    '': [
      {
        target,
        methodDescriptorOrParameterIndex: 0,
        bindingSelector: RestBindings.Http.REQUEST,
        metadata: {
          decorator: '@inject'
        }
      },
      {
        target,
        methodDescriptorOrParameterIndex: 1,
        bindingSelector: RestBindings.Http.RESPONSE,
        metadata: {
          decorator: '@inject'
        }
      }
    ]
  };
}

/**
 * Takes mountPoint and returns a prefix to be used for controller class names
 * @param mountPoint - mount point
 * Example: for mountPoint = "/:facility/client" it returns "FacilityClient"
 */
function getControllerPrefix(mountPoint: string, packageName: string) {
  return _.words(`${mountPoint}/${packageName}`)
    .map(_.capitalize)
    .join('')
    .replace(/^[0-9]/, "X"); // make sure prefix does not start with a number
}

/**
 * Converts path of a URL to lowercase while leaving original casing for query string and path parameters
 * @param url
 */
function pathToLowerCase(url: string): string {
  // split url into path and query string
  const urlParts = url.split('?');
  // split path into parts
  let pathParts = urlParts[0].split('/');
  pathParts = pathParts.map((part) => {
    return part.startsWith(':') ? part : part.toLowerCase(); // don't lower case path parameters
  });
  urlParts[0] = pathParts.join('/');
  return urlParts.join('?');
}

interface LegacyRoute {
  path: string;
  httpMethod: string;
  middleware: (req: Request, res: Response) => {};
}

function defineAuthMetadata(target: any, middlewareSpecs: any) {
  for(const middleware in middlewareSpecs) {
    const authScope = middlewareSpecs[middleware].auth?.scope;
    const {accessLevel} = middlewareSpecs[middleware].auth;
    if (authScope || accessLevel) {
      const authOptions = authScope ? {scope: authScope} : undefined;
      applyMiddlewareSpec(target.prototype, middleware, authOptions);
    }
  }
}

function applyMiddlewareSpec(target: any, method: string, spec: AuthenticationMetadata = {}) {
  const methodDescriptor = Object.getOwnPropertyDescriptor(target, method) as TypedPropertyDescriptor<any>;
  return MethodDecoratorFactory.createDecorator<AuthenticationMetadata>(
    AUTHENTICATION_METADATA_KEY,
    spec,
    {decoratorName: '@authenticate'},
  )(target, method, methodDescriptor);
}
