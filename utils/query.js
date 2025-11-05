module.exports.parseQueryParams = function parseQueryParams(req, defaults) {
    defaults = defaults || {};
    const out = {
        filter: {},
        projection: null,
        sort: null,
        skip: 0,
        limit: defaults.limit || 0,
        count: false,
        error: null
    };

    try {
        if (req.query.where) {
            try {
                out.filter = JSON.parse(req.query.where);
            } catch (e) {
                out.error = `Invalid JSON in where parameter: ${e.message}. Received: ${req.query.where}`;
                return out;
            }
        }
        if (req.query.select) {
            try {
                out.projection = JSON.parse(req.query.select);
            } catch (e) {
                out.error = `Invalid JSON in select parameter: ${e.message}`;
                return out;
            }
        }
        if (req.query.filter && !out.projection) {
            try {
                out.projection = JSON.parse(req.query.filter);
            } catch (e) {
                out.error = `Invalid JSON in filter parameter: ${e.message}`;
                return out;
            }
        }
        if (req.query.sort) {
            try {
                out.sort = JSON.parse(req.query.sort);
            } catch (e) {
                out.error = `Invalid JSON in sort parameter: ${e.message}`;
                return out;
            }
        }
    } catch (e) {
        out.error = `Invalid JSON in query parameters: ${e.message}`;
        return out;
    }

    if (req.query.skip) {
        const s = parseInt(req.query.skip, 10);
        if (Number.isNaN(s) || s < 0) { out.error = 'skip must be a non-negative integer'; return out; }
        out.skip = s;
    }

    if (req.query.limit) {
        const l = parseInt(req.query.limit, 10);
        if (Number.isNaN(l) || l < 0) { out.error = 'limit must be a non-negative integer'; return out; }
        const MAX = defaults.maxLimit || 1000;
        out.limit = Math.min(l, MAX);
    }

    if (req.query.count === 'true' || req.query.count === '1') out.count = true;

    return out;
};
