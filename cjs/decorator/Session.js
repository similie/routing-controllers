"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Session = void 0;
const index_1 = require("../index");
/**
 * Injects a Session object to the controller action parameter.
 * Must be applied on a controller action parameter.
 */
function Session(options) {
    return function (object, methodName, index) {
        (0, index_1.getMetadataArgsStorage)().params.push({
            type: 'session',
            object: object,
            method: methodName,
            index: index,
            parse: false, // it makes no sense for Session object to be parsed as json
            required: options && options.required !== undefined ? options.required : true,
            classTransform: options && options.transform,
            validate: options && options.validate !== undefined ? options.validate : false,
        });
    };
}
exports.Session = Session;
//# sourceMappingURL=Session.js.map