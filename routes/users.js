const e = require('express');

module.exports = function (router) {

    var User = require('../models/user');
    var mongoose = require('mongoose');

    var parseQueryParams = require('../utils/query').parseQueryParams;

    var usersRoute = router.route('/users');
    var usersIdRoute = router.route('/users/:id');

    usersRoute.get(async function (req, res) {

        const q = parseQueryParams(req, { limit: 0, maxLimit: 1000 });
        if (q.error) return res.status(400).json({ message: q.error, data: null });

        try {
            if (q.count) {
                const c = await User.countDocuments(q.filter);
                return res.json({ message: 'OK', data: c });
            }

            let query = User.find(q.filter, q.projection);
            if (q.sort) query = query.sort(q.sort);
            if (q.skip) query = query.skip(q.skip);
            if (q.limit && q.limit > 0) query = query.limit(q.limit);

            const users = await query.exec();
            console.log('Fetched users from DB : ', users.length);
            return res.json({ message: 'OK', data: users });
        } catch (err) {
            console.error('GET /api/users error:', err);
            return res.status(500).json({ message: 'An internal server error occurred', data: null });
        }
    });

    usersRoute.post(async function (req, res) {
        try {
            const user = await User.create({
                name: req.body.name,
                email: req.body.email,
                pendingTasks: []
            });
            return res.status(201).json({ "message": "OK", data: user });

        } catch (err) {
            console.error('POST /api/users error:', err);
            if (err.name === 'ValidationError') {
                return res.status(400).json({ message: 'Name and email are required', data: null });
            }
            if (err.code === 11000) {
                return res.status(409).json({ message: 'Email already exists', data: null });
            }
            return res.status(500).json({ message: 'Could not create user', data: null });
        }
    });

    usersIdRoute.get(async function (req, res) {
        try {
            const id = req.params.id;

            let projection = null;
            if (req.query.select) {
                try {
                    projection = JSON.parse(req.query.select);
                } catch (e) {
                    return res.status(400).json({ message: 'Invalid JSON in select parameter', data: null });
                }
            }

            const user = await User.findById(id, projection);
            if (!user) {
                return res.status(404).json({ message: 'User not found', data: null });
            }
            console.log('Fetched user from DB : ', user._id);
            return res.json({ message: 'OK', data: user });
        } catch (err) {
            console.error('GET /api/users/:id error:', err);
            if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid user ID format', data: null });
            return res.status(500).json({ message: 'An internal server error occurred', data: null });
        }
    });

    usersIdRoute.put(async function (req, res) {
        try {
            const id = req.params.id;
            const newUser = Object.assign({}, req.body);

            let session = null;
            let useTransaction = false;
            try {
                session = await mongoose.startSession();
                session.startTransaction();
                useTransaction = true;
            } catch (e) {
                console.warn('Transactions not available for user update, proceeding without transaction:', e.message || e);
                if (session) session.endSession();
                session = null;
            }

            const user = session ? await User.findById(id).session(session) : await User.findById(id);
            if (!user) {
                if (session) session.endSession();
                return res.status(404).json({ message: 'User not found', data: null });
            }

            const prevPending = Array.isArray(user.pendingTasks) ? user.pendingTasks.map(String) : [];

            const opts = { new: true, runValidators: true, context: 'query' };
            const updated = session ? await User.findByIdAndUpdate(id, { $set: newUser }, opts).session(session) : await User.findByIdAndUpdate(id, { $set: newUser }, opts);

            if (Object.prototype.hasOwnProperty.call(newUser, 'pendingTasks')) {
                const newPending = Array.isArray(newUser.pendingTasks) ? newUser.pendingTasks.map(String) : [];
                const toAdd = newPending.filter(x => !prevPending.includes(x));
                const toRemove = prevPending.filter(x => !newPending.includes(x));

                for (const tId of toAdd) {
                    const taskDoc = session ? await require('../models/task').findById(tId).session(session) : await require('../models/task').findById(tId);
                    if (!taskDoc) {
                        if (useTransaction && session) await session.abortTransaction();
                        if (session) session.endSession();
                        return res.status(400).json({ message: `Task ${tId} does not exist`, data: null });
                    }
                }

                for (const tId of toAdd) {
                    const setOp = { $set: { assignedUser: String(updated._id), assignedUserName: updated.name } };
                    if (session) await require('../models/task').findByIdAndUpdate(tId, setOp, { new: true }).session(session);
                    else await require('../models/task').findByIdAndUpdate(tId, setOp, { new: true });
                }

                for (const tId of toRemove) {
                    const setOp = { $set: { assignedUser: '', assignedUserName: 'unassigned' } };
                    if (session) await require('../models/task').findByIdAndUpdate(tId, setOp, { new: true }).session(session);
                    else await require('../models/task').findByIdAndUpdate(tId, setOp, { new: true });
                }
            }

            if (newUser.name && newUser.name !== user.name) {
                const setNameOp = { $set: { assignedUserName: newUser.name } };
                if (session) await require('../models/task').updateMany({ assignedUser: String(id) }, setNameOp).session(session);
                else await require('../models/task').updateMany({ assignedUser: String(id) }, setNameOp);
            }

            if (useTransaction && session) {
                await session.commitTransaction();
                session.endSession();
            }

            return res.status(200).json({ message: 'OK', data: updated });
        } catch (err) {
            console.error('PUT /api/users/:id error:', err);
            if (err.name === 'CastError') {
                return res.status(404).json({ message: 'Invalid user ID format', data: null });
            }
            if (err.name === 'ValidationError') {
                return res.status(400).json({ message: 'Name and email are required', data: null });
            }
            if (err.code === 11000) {
                return res.status(409).json({ message: 'Email already exists', data: null });
            }
            return res.status(500).json({ message: 'Could not update user', data: null });
        }
    });

    usersIdRoute.delete(async function (req, res) {
        try {
            const id = req.params.id;

            let session = null;
            let useTransaction = false;
            try {
                session = await mongoose.startSession();
                session.startTransaction();
                useTransaction = true;
            } catch (e) {
                console.warn('Transactions not available for user delete, proceeding without transaction:', e.message || e);
                if (session) session.endSession();
                session = null;
            }

            const user = session ? await User.findById(id).session(session) : await User.findById(id);
            if (!user) {
                if (session) session.endSession();
                return res.status(404).json({ message: 'User not found', data: null });
            }

            const pending = Array.isArray(user.pendingTasks) ? user.pendingTasks.map(String) : [];

            if (pending.length > 0) {
                const setOp = { $set: { assignedUser: '', assignedUserName: 'unassigned' } };
                if (session) await require('../models/task').updateMany({ _id: { $in: pending } }, setOp).session(session);
                else await require('../models/task').updateMany({ _id: { $in: pending } }, setOp);
            }

            if (session) await User.findByIdAndDelete(id).session(session);
            else await User.findByIdAndDelete(id);

            if (useTransaction && session) {
                await session.commitTransaction();
                session.endSession();
            }

            return res.status(200).json({ message: 'OK', data: user });
        } catch (err) {
            console.error('DELETE /api/users/:id error:', err);
            if (err.name === 'CastError') {
                return res.status(400).json({ message: 'Invalid user ID format', data: null });
            }
            return res.status(500).json({ message: 'Could not delete user', data: null });
        }
    });

    return router;
}
