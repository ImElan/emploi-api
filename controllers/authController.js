const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const ErrorHandler = require('../utils/errorHandler');
const Email = require('../utils/sendMail');
const filterBody = require('../utils/filterBody');

const getJwtToken = (id) =>
    jwt.sign({ id: id }, process.env.JWT_SECRET_KEY, {
        expiresIn: process.env.JWT_EXPIRATION_TIME,
    });

const sendJwtToken = (user, statusCode, req, res) => {
    const tokenId = getJwtToken(user.id);

    const cookieOptions = {
        expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRATION_TIME * 24 * 60 * 60 * 1000
        ),
        httpOnly: true,
    };

    if (req.secure) {
        cookieOptions.secure = true;
    }
    // console.log(req.secure);
    res.cookie('jwt', tokenId, cookieOptions);
    user.password = undefined;
    res.status(statusCode).json({
        status: 'success',
        tokenId,
        data: {
            document: {
                user,
            },
        },
    });
};

const sendConfirmationMail = async (user, req, res) => {
    const tokenId = getJwtToken(user.id);
    const URL = `${req.protocol}://${req.get('host')}/api/v1/users/confirm/${tokenId}`;
    await new Email(user, URL).sendConfirmationMail();

    res.status(200).json({
        status: 'success',
        data: {
            message:
                'Please Confirm Your Email to continue. A link has been sent to your email address. (Valid Only For 90 days).',
        },
    });
};

exports.signUp = catchAsync(async (req, res, next) => {
    let filteredBody;

    // On Production we don't want to allow users to make themselves as admin,rep... and also we don't want them to just confirm the email through api.
    if (process.env.NODE_ENV === 'production') {
        filteredBody = filterBody(
            req.body,
            'name',
            'email',
            'photo',
            'password',
            'passwordConfirmation'
        );
    } else {
        filteredBody = filterBody(
            req.body,
            'name',
            'email',
            'photo',
            'password',
            'passwordConfirmation',
            'role',
            'confirmed'
        );
    }

    const user = await User.create(filteredBody);

    // In development we can just login straight away...no need to confirm email.
    if (process.env.NODE_ENV === 'production') {
        sendConfirmationMail(user, req, res);
    } else {
        sendJwtToken(user, 200, req, res);
    }
});

exports.login = catchAsync(async (req, res, next) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return next(new ErrorHandler('Please provide email and password to login', 400));
    }

    // have to use findOne because it only returns the document find returns cursor to that document... prototype methods can be called only on document.
    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.isPasswordCorrect(password, user.password))) {
        return next(new ErrorHandler('Incorrect email or password', 401));
    }

    if (!user.confirmed) {
        return next(new ErrorHandler('Please confirm your mail first to login', 401));
    }

    sendJwtToken(user, 200, req, res);
});

exports.isAuthenticated = catchAsync(async (req, res, next) => {
    let tokenId;
    if (req.headers.authorization) {
        tokenId = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.jwt) {
        tokenId = req.cookies.jwt;
    }
    if (!tokenId) {
        return next(
            new ErrorHandler(
                "You're not logged in. Please Login to get access to this URL",
                401
            )
        );
    }

    const decodedPayload = await promisify(jwt.verify)(tokenId, process.env.JWT_SECRET_KEY);

    const user = await User.findById(decodedPayload.id);

    if (!user) {
        return next(new ErrorHandler("There's no account with the given email address.", 401));
    }

    if (user.isPasswordChangedAfterTokenIsIssued(decodedPayload.iat)) {
        return next(
            new ErrorHandler(
                'Your account password has been changed. Please login again to continue',
                401
            )
        );
    }

    req.user = user;
    next();
});

exports.restrictTo = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
        return next(new ErrorHandler("You're not allowed to access this route.", 403));
    }
    next();
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
    const { email } = req.body;
    if (!email) {
        return next(
            new ErrorHandler('Please provide email address to change your password.', 400)
        );
    }

    const user = await User.findOne({ email });
    if (!user) {
        return next(new ErrorHandler('No user exists with that email id', 404));
    }

    const resetToken = user.createPasswordResetToken();

    await user.save({ validateBeforeSave: false });

    const resetURL = `${req.protocol}://${req.get(
        'host'
    )}/api/v1/user/resetPassword/${resetToken}`;

    try {
        await new Email(user, resetURL).sendResetPassword();
        res.status(200).json({
            status: 'success',
            message: 'Token Id (URL) to reset your password was sent to your email address.',
        });
    } catch (error) {
        user.passwordResetToken = undefined;
        user.passwordResetExpiresIn = undefined;
        await user.save({ validateBeforeSave: false });
        return next(
            new ErrorHandler(
                "There's some problem with sending email. Please try again later.",
                500
            )
        );
    }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
    const { resetToken } = req.params;
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpiresIn: { $gt: Date.now() },
    });

    if (!user) {
        return next(new ErrorHandler('Token is invalid or expired.', 400));
    }

    user.password = req.body.password;
    user.passwordConfirmation = req.body.passwordConfirmation;
    user.passwordResetToken = undefined;
    user.passwordResetExpiresIn = undefined;

    await user.save();

    sendJwtToken(user, 200, req, res);
});

exports.updatePassword = catchAsync(async (req, res, next) => {
    const user = await User.findById(req.user.id).select('+password');

    const { currentPassword, newPassword, newPasswordConfirmation } = req.body;

    if (!user || !(await user.isPasswordCorrect(currentPassword, user.password))) {
        return next(
            new ErrorHandler(
                "Given password doesn't match the current password. If you've forgotten the password use forgot password URL",
                401
            )
        );
    }

    user.password = newPassword;
    user.passwordConfirmation = newPasswordConfirmation;

    await user.save();
    sendJwtToken(user, 200, req, res);
});

exports.confirmMail = catchAsync(async (req, res, next) => {
    const { tokenId } = req.params;
    if (!tokenId) {
        return next(new ErrorHandler("There's something wrong with the URL", 400));
    }

    const decodedPayload = await promisify(jwt.verify)(tokenId, process.env.JWT_SECRET_KEY);
    const user = await User.findById(decodedPayload.id);

    if (!user) {
        return next(new ErrorHandler('Invalid Token or The token has been modified.', 400));
    }

    user.confirmed = true;
    await user.save({ validateBeforeSave: false });
    sendJwtToken(user, 201, req, res);
});

exports.resendConfirmationMail = catchAsync(async (req, res, next) => {
    const { email } = req.body;
    if (!email) {
        return next(
            new ErrorHandler('You must mention your email to send the confirmation link', 400)
        );
    }
    const user = await User.findOne({ email });
    if (!user) {
        return next(
            new ErrorHandler('No user found for the given email address. Try Signing up.', 404)
        );
    }
    sendConfirmationMail(user, req, res);
});
