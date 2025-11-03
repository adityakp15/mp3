const e = require('express');
var mongoose = require('mongoose');
var parseQueryParams = require('../utils/query').parseQueryParams;

module.exports = function (router) {

    var User = require('../models/user');
    var Task = require('../models/task');

    var tasksRoute = router.route('/tasks');
    var tasksIdRoute = router.route('/tasks/:id');

    tasksRoute.get(async function (req,res){
        const q = parseQueryParams(req, { limit: 100, maxLimit: 1000 });
        if (q.error) return res.status(400).json({ message: q.error, data: null });

        try {
            if (q.count) {
                const c = await Task.countDocuments(q.filter);
                return res.json({ message: 'OK', data: c });
            }

            let query = Task.find(q.filter, q.projection);
            if (q.sort) query = query.sort(q.sort);
            if (q.skip) query = query.skip(q.skip);
            if (q.limit && q.limit > 0) query = query.limit(q.limit);

            const tasks = await query.exec();
            console.log('Fetched tasks from DB : ', tasks.length);
            return res.json({"message":"OK", data: tasks });
        } catch (err) {
            console.error('GET /api/tasks error:', err);
            return res.status(500).json({ message: 'An internal server error occurred', data: null });
        }
    });

    tasksRoute.post(async function (req, res){
        try {
            console.log('Creating task with data: ', req.body);

            const name = req.body.name;
            const description = req.body.description || '';
            const deadlineRaw = req.body.deadline;
            const completedRaw = req.body.completed;
            const assignedUserRaw = req.body.assignedUser || '';
            const assignedUserNameRaw = req.body.assignedUserName || (assignedUserRaw ? 'assigned' : 'unassigned');

            if (!name) {
                return res.status(400).json({ message: 'Task name is required', data: null });
            }

            let deadline;
            if (deadlineRaw === undefined || deadlineRaw === null || deadlineRaw === '') {
                return res.status(400).json({ message: 'Task deadline is required', data: null });
            }
            const numeric = Number(deadlineRaw);
            if (!Number.isNaN(numeric)) {
                deadline = new Date(numeric);
            } else {
                const parsed = Date.parse(String(deadlineRaw));
                if (Number.isNaN(parsed)) return res.status(400).json({ message: 'Invalid deadline', data: null });
                deadline = new Date(parsed);
            }

            const completed = (completedRaw === true || completedRaw === 'true' || completedRaw === 'True');
            const assignedUser = assignedUserRaw ? String(assignedUserRaw) : '';
            const assignedUserName = String(assignedUserNameRaw);

            if (assignedUser) {
                const userDoc = await User.findById(assignedUser);
                if (!userDoc) {
                    return res.status(400).json({ message: 'Assigned user does not exist', data: null });
                }
            }

            const task = await Task.create({
                name,
                description,
                deadline,
                completed,
                assignedUser,
                assignedUserName
            });

            if (assignedUser && !completed) {
                await User.updateOne({ _id: assignedUser }, { $addToSet: { pendingTasks: String(task._id) } });
            }

            return res.status(201).json({ "message": "OK", data: task });

        } catch (err) {
            console.error('POST /api/tasks error:', err);
            if (err.name === 'ValidationError') {
                return res.status(400).json({ message: 'Task name and deadline are required', data: null });
            }
            return res.status(500).json({ message: 'Could not create task', data: null });
        }
    });

    tasksIdRoute.get(async function (req, res){
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

            const taskDoc = await Task.findById(id, projection);
            if (!taskDoc) {
                return res.status(404).json({ message: 'Task not found', data: null });
            }
            console.log('Fetched task from DB : ', taskDoc._id);
            return res.json({ message: 'OK', data: taskDoc });
        } catch (err) {
            console.error('GET /api/tasks/:id error:', err);
            if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid task ID format', data: null });
            return res.status(500).json({ message: 'An internal server error occurred', data: null });
        }
    });

    tasksIdRoute.put(async function (req, res){
        try {
            const id = req.params.id;
            const newTask = Object.assign({}, req.body);
            console.log('Updating task id ', id, ' with data: ', newTask);

            let session = null;
            let useTransaction = false;
            try {
                session = await mongoose.startSession();
                session.startTransaction();
                useTransaction = true;
            } catch (e) {
                console.warn('Transactions not available for task update, proceeding without transaction:', e && e.message ? e.message : e);
                if (session) session.endSession();
                session = null;
            }

            const taskDoc = session ? await Task.findById(id).session(session) : await Task.findById(id);
            if (!taskDoc) {
                if (session) session.endSession();
                return res.status(404).json({ message: 'Task not found', data: null });
            }

            const prevAssigned = taskDoc.assignedUser ? String(taskDoc.assignedUser) : null;
            const prevCompleted = !!taskDoc.completed;

            const opts = { new: true, runValidators: true, context: 'query' };
            const updatedTask = session ? await Task.findByIdAndUpdate(id, { $set: newTask }, opts).session(session) : await Task.findByIdAndUpdate(id, { $set: newTask }, opts);

            const newAssigned = updatedTask.assignedUser ? String(updatedTask.assignedUser) : null;

            if (prevAssigned && prevAssigned !== newAssigned) {
                if (session) await User.updateOne({ _id: prevAssigned }, { $pull: { pendingTasks: id } }).session(session);
                else await User.updateOne({ _id: prevAssigned }, { $pull: { pendingTasks: id } });
            }

            if (newAssigned && prevAssigned !== newAssigned) {
                const newUser = session ? await User.findById(newAssigned).session(session) : await User.findById(newAssigned);
                if (!newUser) {
                    if (useTransaction && session) await session.abortTransaction();
                    if (session) session.endSession();
                    return res.status(400).json({ message: 'Assigned user does not exist', data: null });
                }
                if (session) await User.updateOne({ _id: newAssigned }, { $addToSet: { pendingTasks: id } }).session(session);
                else await User.updateOne({ _id: newAssigned }, { $addToSet: { pendingTasks: id } });
            }

            if (updatedTask.completed && !prevCompleted && newAssigned) {
                if (session) await User.updateOne({ _id: newAssigned }, { $pull: { pendingTasks: id } }).session(session);
                else await User.updateOne({ _id: newAssigned }, { $pull: { pendingTasks: id } });
            }

            if (useTransaction && session) {
                await session.commitTransaction();
                session.endSession();
            }

            return res.status(200).json({ message: 'OK', data: updatedTask });
        } catch (err) {
            console.error('PUT /api/tasks/:id error:', err);
            if (err.name === 'ValidationError') {
                return res.status(400).json({ message: 'Task name and deadline are required', data: null });
            }
            return res.status(500).json({ message: 'Could not update task', data: null });
        }
    });

    tasksIdRoute.delete(async function (req, res){
        try {
            const id = req.params.id;

            let session = null;
            let useTransaction = false;
            try {
                session = await mongoose.startSession();
                session.startTransaction();
                useTransaction = true;
            } catch (e) {
                console.warn('Transactions not available for task delete, proceeding without transaction:', e && e.message ? e.message : e);
                if (session) session.endSession();
                session = null;
            }

            const taskDoc = session ? await Task.findById(id).session(session) : await Task.findById(id);
            if (!taskDoc) {
                if (session) session.endSession();
                return res.status(404).json({ message: 'Task not found', data: null });
            }

            const assigned = taskDoc.assignedUser ? String(taskDoc.assignedUser) : null;

            if (assigned) {
                if (session) await User.updateOne({ _id: assigned }, { $pull: { pendingTasks: id } }).session(session);
                else await User.updateOne({ _id: assigned }, { $pull: { pendingTasks: id } });
            }

            const deleted = session ? await Task.findByIdAndDelete(id).session(session) : await Task.findByIdAndDelete(id);

            if (useTransaction && session) {
                await session.commitTransaction();
                session.endSession();
            }

            return res.status(200).json({ message: 'OK', data: deleted });
        } catch (err) {
            console.error('DELETE /api/tasks/:id error:', err);
            return res.status(500).json({ message: 'Could not delete task', data: null });
        }
    });

    return router;
}
