import { ActionMetadata } from '../../metadata/ActionMetadata';
import { BaseDriver } from '../BaseDriver';
import { AuthorizationCheckerNotDefinedError } from '../../error/AuthorizationCheckerNotDefinedError';
import { AccessDeniedError } from '../../error/AccessDeniedError';
import { isPromiseLike } from '../../util/isPromiseLike';
import { getFromContainer } from '../../container';
import { AuthorizationRequiredError } from '../../error/AuthorizationRequiredError';
import { HttpError, NotFoundError } from '../../index';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cookie = require('cookie');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const templateUrl = require('template-url');
/**
 * Integration with koa framework.
 */
export class KoaDriver extends BaseDriver {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(koa, router) {
        super();
        this.koa = koa;
        this.router = router;
        this.loadKoa();
        this.loadRouter();
        this.app = this.koa;
    }
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    /**
     * Initializes the things driver needs before routes and middleware registration.
     */
    initialize() {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const bodyParser = require('koa-bodyparser');
        this.koa.use(bodyParser());
        if (this.cors) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const cors = require('@koa/cors');
            if (this.cors === true) {
                this.koa.use(cors());
            }
            else {
                this.koa.use(cors(this.cors));
            }
        }
    }
    /**
     * Registers middleware that run before controller actions.
     */
    registerMiddleware(middleware) {
        if (middleware.instance.use) {
            this.koa.use(function (ctx, next) {
                return middleware.instance.use(ctx, next);
            });
        }
    }
    /**
     * Registers action in the driver.
     */
    registerAction(actionMetadata, executeCallback) {
        // middlewares required for this action
        const defaultMiddlewares = [];
        if (actionMetadata.isAuthorizedUsed) {
            defaultMiddlewares.push((context, next) => {
                if (!this.authorizationChecker)
                    throw new AuthorizationCheckerNotDefinedError();
                const action = { request: context.request, response: context.response, context, next };
                try {
                    const checkResult = actionMetadata.authorizedRoles instanceof Function
                        ? getFromContainer(actionMetadata.authorizedRoles, action).check(action)
                        : this.authorizationChecker(action, actionMetadata.authorizedRoles);
                    const handleError = (result) => {
                        if (!result) {
                            const error = actionMetadata.authorizedRoles.length === 0
                                ? new AuthorizationRequiredError(action)
                                : new AccessDeniedError(action);
                            return this.handleError(error, actionMetadata, action);
                        }
                        else {
                            return next();
                        }
                    };
                    if (isPromiseLike(checkResult)) {
                        return checkResult
                            .then(result => handleError(result))
                            .catch(error => this.handleError(error, actionMetadata, action));
                    }
                    else {
                        return handleError(checkResult);
                    }
                }
                catch (error) {
                    return this.handleError(error, actionMetadata, action);
                }
            });
        }
        if (actionMetadata.isFileUsed || actionMetadata.isFilesUsed) {
            const multer = this.loadMulter();
            actionMetadata.params
                .filter(param => param.type === 'file')
                .forEach(param => {
                defaultMiddlewares.push(multer(param.extraOptions).single(param.name));
            });
            actionMetadata.params
                .filter(param => param.type === 'files')
                .forEach(param => {
                defaultMiddlewares.push(multer(param.extraOptions).array(param.name));
            });
        }
        // user used middlewares
        const uses = actionMetadata.controllerMetadata.uses.concat(actionMetadata.uses);
        const beforeMiddlewares = this.prepareMiddlewares(uses.filter(use => !use.afterAction));
        const afterMiddlewares = this.prepareMiddlewares(uses.filter(use => use.afterAction));
        // prepare route and route handler function
        let route = ActionMetadata.appendBaseRoute(this.routePrefix, actionMetadata.fullRoute);
        // @koa/router is strict about trailing slashes, allow accessing routes without them
        if (typeof route === 'string' && route.length > 1 && route.endsWith('/')) {
            route = route.substring(0, route.length - 1);
        }
        const routeHandler = (context, next) => {
            const options = { request: context.request, response: context.response, context, next };
            return executeCallback(options);
        };
        // This ensures that a request is only processed once. Multiple routes may match a request
        // e.g. GET /users/me matches both @All(/users/me) and @Get(/users/:id)), only the first matching route should
        // be called.
        // The following middleware only starts an action processing if the request has not been processed before.
        const routeGuard = (context, next) => {
            if (!context.request.routingControllersStarted) {
                context.request.routingControllersStarted = true;
                return next();
            }
        };
        // finally register action in koa
        this.router[actionMetadata.type.toLowerCase()](...[route, routeGuard, ...beforeMiddlewares, ...defaultMiddlewares, routeHandler, ...afterMiddlewares]);
    }
    /**
     * Registers all routes in the framework.
     */
    registerRoutes() {
        this.koa.use(this.router.routes());
        this.koa.use(this.router.allowedMethods());
    }
    /**
     * Gets param from the request.
     */
    getParamFromRequest(actionOptions, param) {
        const context = actionOptions.context;
        const request = actionOptions.request;
        switch (param.type) {
            case 'body':
                return request.body;
            case 'body-param':
                return request.body[param.name];
            case 'param':
                return context.params[param.name];
            case 'params':
                return context.params;
            case 'session':
                return context.session;
            case 'session-param':
                return context.session[param.name];
            case 'state':
                if (param.name)
                    return context.state[param.name];
                return context.state;
            case 'query':
                return context.query[param.name];
            case 'queries':
                return context.query;
            case 'file':
                return actionOptions.context.request.file;
            case 'files':
                return actionOptions.context.request.files;
            case 'header':
                return context.headers[param.name.toLowerCase()];
            case 'headers':
                return request.headers;
            case 'cookie':
                if (!context.headers.cookie)
                    return;
                const cookies = cookie.parse(context.headers.cookie);
                return cookies[param.name];
            case 'cookies':
                if (!request.headers.cookie)
                    return {};
                return cookie.parse(request.headers.cookie);
        }
    }
    /**
     * Handles result of successfully executed controller action.
     */
    handleSuccess(result, action, options) {
        // if the action returned the context or the response object itself, short-circuits
        if (result && (result === options.response || result === options.context)) {
            return options.next();
        }
        // transform result if needed
        result = this.transformResult(result, action, options);
        if (action.redirect) {
            // if redirect is set then do it
            if (typeof result === 'string') {
                options.response.redirect(result);
            }
            else if (result instanceof Object) {
                options.response.redirect(templateUrl(action.redirect, result));
            }
            else {
                options.response.redirect(action.redirect);
            }
        }
        else if (action.renderedTemplate) {
            // if template is set then render it // TODO: not working in koa
            const renderOptions = result && result instanceof Object ? result : {};
            this.koa.use(async function (ctx, next) {
                await ctx.render(action.renderedTemplate, renderOptions);
            });
        }
        else if (result === undefined) {
            // throw NotFoundError on undefined response
            if (action.undefinedResultCode instanceof Function) {
                throw new action.undefinedResultCode(options);
            }
            else if (!action.undefinedResultCode) {
                throw new NotFoundError();
            }
        }
        else if (result === null) {
            // send null response
            if (action.nullResultCode instanceof Function)
                throw new action.nullResultCode(options);
            options.response.body = null;
        }
        else if (result instanceof Uint8Array) {
            // check if it's binary data (typed array)
            options.response.body = Buffer.from(result);
        }
        else {
            // send regular result
            options.response.body = result;
        }
        // set http status code
        if (result === undefined && action.undefinedResultCode) {
            options.response.status = action.undefinedResultCode;
        }
        else if (result === null && action.nullResultCode) {
            options.response.status = action.nullResultCode;
        }
        else if (action.successHttpCode) {
            options.response.status = action.successHttpCode;
        }
        else if (options.response.body === null) {
            options.response.status = 204;
        }
        // apply http headers
        Object.keys(action.headers).forEach(name => {
            options.response.set(name, action.headers[name]);
        });
        return options.next();
    }
    /**
     * Handles result of failed executed controller action.
     */
    handleError(error, action, options) {
        return new Promise((resolve, reject) => {
            if (this.isDefaultErrorHandlingEnabled) {
                // apply http headers
                if (action) {
                    Object.keys(action.headers).forEach(name => {
                        options.response.set(name, action.headers[name]);
                    });
                }
                // send error content
                if (action && action.isJsonTyped) {
                    options.response.body = this.processJsonError(error);
                }
                else {
                    options.response.body = this.processTextError(error);
                }
                // set http status
                if (error instanceof HttpError && error.httpCode) {
                    options.response.status = error.httpCode;
                }
                else {
                    options.response.status = 500;
                }
                return resolve();
            }
            return reject(error);
        });
    }
    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------
    /**
     * Creates middlewares from the given "use"-s.
     */
    prepareMiddlewares(uses) {
        const middlewareFunctions = [];
        uses.forEach(use => {
            if (use.middleware.prototype && use.middleware.prototype.use) {
                // if this is function instance of MiddlewareInterface
                middlewareFunctions.push(async (context, next) => {
                    try {
                        return await getFromContainer(use.middleware).use(context, next);
                    }
                    catch (error) {
                        return await this.handleError(error, undefined, {
                            request: context.request,
                            response: context.response,
                            context,
                            next,
                        });
                    }
                });
            }
            else {
                middlewareFunctions.push(use.middleware);
            }
        });
        return middlewareFunctions;
    }
    /**
     * Dynamically loads koa module.
     */
    loadKoa() {
        if (require) {
            if (!this.koa) {
                try {
                    this.koa = new (require('koa'))();
                }
                catch (e) {
                    throw new Error('koa package was not found installed. Try to install it: npm install koa@next --save');
                }
            }
        }
        else {
            throw new Error('Cannot load koa. Try to install all required dependencies.');
        }
    }
    /**
     * Dynamically loads @koa/router module.
     */
    loadRouter() {
        if (require) {
            if (!this.router) {
                try {
                    this.router = new (require('@koa/router'))();
                }
                catch (e) {
                    throw new Error('@koa/router package was not found installed. Try to install it: npm install @koa/router --save');
                }
            }
        }
        else {
            throw new Error('Cannot load koa. Try to install all required dependencies.');
        }
    }
    /**
     * Dynamically loads @koa/multer module.
     */
    loadMulter() {
        try {
            return require('@koa/multer');
        }
        catch (e) {
            throw new Error('@koa/multer package was not found installed. Try to install it: npm install @koa/multer --save');
        }
    }
}
//# sourceMappingURL=KoaDriver.js.map