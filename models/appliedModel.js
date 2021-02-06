const mongoose = require('mongoose');

const appliedSchema = mongoose.Schema({
    test: {
        type: mongoose.Schema.ObjectId,
        ref: 'Test',
        required: [true, 'Applied test should refer to a test.'],
    },
    user: {
        type: mongoose.Schema.ObjectId,
        ref: 'user',
        required: [true, 'Applied test should belong to a user.'],
    },
    appliedAt: {
        type: Date,
        default: Date.now(),
    },
});

const Applied = mongoose.model('Applied', appliedSchema);

module.exports = Applied;