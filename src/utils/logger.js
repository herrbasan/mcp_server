import { createLogger, getLogger, resetLogger } from '../nLogger/src/logger.js';

process.env.DEBUG = 'true'; // TEMPORARY DEBUG FLAG

export function interceptConsole(logger) {
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;

    function extractTypeAndMessage(args) {
        let msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        let type = 'System';
        
        // Match common patterns like "[Network] connected"
        const match = msg.match(/^\[(.*?)\]\s*(.*)$/);
        if (match) {
            type = match[1];
            msg = match[2];
        }
        
        return { type, msg };
    }

    console.log = (...args) => {
        const { type, msg } = extractTypeAndMessage(args);
        logger.info(msg, {}, type);
        origLog.apply(console, args);
    };

    console.info = (...args) => {
        const { type, msg } = extractTypeAndMessage(args);
        logger.info(msg, {}, type);
        origInfo.apply(console, args);
    };

    console.warn = (...args) => {
        const { type, msg } = extractTypeAndMessage(args);
        logger.warn(msg, {}, type);
        origWarn.apply(console, args);
    };

    console.error = (...args) => {
        const { type, msg } = extractTypeAndMessage(args);
        logger.error(msg, null, {}, type);
        origError.apply(console, args);
    };

    console.debug = (...args) => {
        const { type, msg } = extractTypeAndMessage(args);
        logger.debug(msg, {}, type);
        if(origDebug) origDebug.apply(console, args);
    };
}

export { createLogger, getLogger, resetLogger };
