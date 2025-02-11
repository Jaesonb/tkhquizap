require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const db = require('./db');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Set the view engine to EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Explicitly set views directory

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

// JWT-based authentication middleware
const authenticateToken = (req, res, next) => {
    const token = req.session.token;
    if (!token) return res.redirect('/login');
    jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
        if (err) return res.redirect('/login');
        req.user = user;
        next();
    });
};

// Middleware to ensure the user is an admin
const ensureAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).send('Access denied');
    }
    next();
};

// Root route: redirect to /login or render a welcome page
app.get('/', (req, res) => res.redirect('/login'));

// GET route for login page
app.get('/login', (req, res) => res.render('login'));

// GET route for registration page
app.get('/register', (req, res) => res.render('register'));

// Register a new user
app.post('/register', async (req, res) => {
    const { username, password, isAdmin } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const is_admin = isAdmin || false;

    try {
        await db.query('INSERT INTO users (username, password, is_admin) VALUES ($1, $2, $3)', [username, hashedPassword, is_admin]);
        res.redirect('/login');
    } catch (err) {
        if (err.code === '23505') { // Postgres unique violation error code for duplicate usernames
            res.status(400).send('Username already exists');
        } else {
            res.status(500).send('User registration failed');
        }
    }
});

// Login route
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.query('SELECT * FROM users WHERE username = $1', [username]);

        if (user.rows.length && await bcrypt.compare(password, user.rows[0].password)) {
            const isAdmin = user.rows[0].is_admin;

            // Generate a JWT token and store it in the session
            const token = jwt.sign(
                { userId: user.rows[0].user_id, isAdmin: isAdmin },
                process.env.JWT_SECRET || 'your_jwt_secret'
            );
            req.session.token = token;

            // Redirect based on user role
            if (isAdmin) {
                res.redirect('/admin');
            } else {
                res.redirect('/user-dashboard');
            }
        } else {
            res.status(401).send('Invalid credentials');
        }
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).send('Login failed');
    }
});

// User dashboard to display either score or quiz based on quiz completion
app.get('/user-dashboard', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        // Check if the user has any answers recorded in `user_answers`
        const answersResult = await db.query('SELECT * FROM user_answers WHERE user_id = $1', [userId]);
        const hasAnswers = answersResult.rows.length > 0;

        let highestScore = 0;
        let hasTakenQuiz = false;
        let questions = {};

        if (hasAnswers) {
            // If the user has answers, fetch their highest score
            const scoreResult = await db.query('SELECT highest_score FROM user_scores WHERE user_id = $1', [userId]);
            if (scoreResult.rows.length > 0) {
                highestScore = scoreResult.rows[0].highest_score;
            }
            hasTakenQuiz = true;
        } else {
            // If the user has no answers, load the quiz questions
            const questionsResult = await db.query(`
                SELECT q.question_id, q.question_text, a.answer_id, a.answer_text
                FROM questions q
                JOIN answers a ON q.question_id = a.question_id
                ORDER BY q.question_id
            `);

            questionsResult.rows.forEach(row => {
                if (!questions[row.question_id]) {
                    questions[row.question_id] = {
                        question_text: row.question_text,
                        answers: []
                    };
                }
                questions[row.question_id].answers.push({
                    answer_id: row.answer_id,
                    answer_text: row.answer_text
                });
            });
        }

        // Render user dashboard with quiz questions or score, as appropriate
        res.render('user_dashboard', { hasTakenQuiz, highestScore, questions });
    } catch (err) {
        console.error("Error loading user dashboard:", err);
        res.status(500).send('Failed to load user dashboard');
    }
});


// Admin-only dashboard route with scores
app.get('/admin', authenticateToken, ensureAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.username, COALESCE(us.highest_score, 0) AS highest_score
            FROM users u
            LEFT JOIN user_scores us ON u.user_id = us.user_id
            WHERE u.is_admin = FALSE
            ORDER BY u.username
        `);
        res.render('admin_dashboard', { scores: result.rows });
    } catch (err) {
        console.error("Error fetching user scores:", err);
        res.status(500).send('Failed to load user scores');
    }
});

// Admin-only route to add questions and answers
app.post('/admin/questions', authenticateToken, ensureAdmin, async (req, res) => {
    const { questionText, answers } = req.body;

    try {
        const result = await db.query(
            'INSERT INTO questions (question_text) VALUES ($1) RETURNING question_id',
            [questionText]
        );
        const questionId = result.rows[0].question_id;

        for (let answer of answers) {
            const answerText = answer.text;
            const isCorrect = answer.isCorrect === 'on'; 
            await db.query(
                'INSERT INTO answers (question_id, answer_text, is_correct) VALUES ($1, $2, $3)',
                [questionId, answerText, isCorrect]
            );
        }
        res.redirect('/admin'); // Redirect back to the admin page
    } catch (err) {
        console.error("Error adding question:", err);
        res.status(500).send('Failed to add question');
    }
});

// Handle questionnaire submission and calculate score
app.post('/submit-answers', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    let answers = req.body.answers;

    // Log the submitted answers for debugging
    console.log("Original submitted answers:", answers);

    // Transform answers to an object if it arrives as an array
    if (Array.isArray(answers)) {
        answers = Object.fromEntries(answers.map((ans, index) => [index + 1, ans]));
    }

    console.log("Processed answers as object:", answers);

    if (!answers || typeof answers !== 'object' || Object.keys(answers).length === 0) {
        console.error("Invalid answer submission:", answers);
        return res.status(400).send('Invalid answer submission');
    }

    try {
        const validQuestionIdsResult = await db.query('SELECT question_id FROM questions');
        const validQuestionIds = validQuestionIdsResult.rows.map(row => row.question_id);

        let score = 0;

        await Promise.all(Object.keys(answers).map(async (questionId) => {
            const parsedQuestionId = parseInt(questionId, 10);

            if (!validQuestionIds.includes(parsedQuestionId)) {
                console.error(`Invalid question ID submitted: ${parsedQuestionId}`);
                throw new Error(`Invalid question ID: ${parsedQuestionId}`);
            }

            const selectedAnswerId = parseInt(answers[questionId], 10);
            if (!selectedAnswerId) {
                console.error(`Answer ID not found for question ${questionId}`);
                throw new Error(`Answer ID missing for question ${questionId}`);
            }

            const answerResult = await db.query('SELECT is_correct FROM answers WHERE answer_id = $1', [selectedAnswerId]);
            if (answerResult.rows.length === 0) {
                console.error(`Answer with ID ${selectedAnswerId} does not exist in the database`);
                throw new Error(`Invalid answer ID ${selectedAnswerId}`);
            }

            const isCorrect = answerResult.rows[0].is_correct;
            if (isCorrect) score += 1;

            await db.query(
                'INSERT INTO user_answers (user_id, question_id, selected_answer, is_correct) VALUES ($1, $2, $3, $4)',
                [userId, parsedQuestionId, selectedAnswerId, isCorrect]
            );
        }));

        // Retrieve the user's current highest score from user_scores
        const existingScore = await db.query('SELECT highest_score FROM user_scores WHERE user_id = $1', [userId]);
        const existingHighestScore = existingScore.rows[0]?.highest_score || 0;

        // Update the highest score only if the new score is greater
        if (score > existingHighestScore) {
            await db.query(`
                INSERT INTO user_scores (user_id, highest_score)
                VALUES ($1, $2)
                ON CONFLICT (user_id)
                DO UPDATE SET highest_score = $2
                WHERE user_scores.highest_score < $2;
            `, [userId, score]);
        }

        res.redirect('/user-dashboard');
    } catch (err) {
        console.error("Error in /submit-answers route:", err);
        res.status(500).send('Error submitting answers');
    }
});


// Route to reset quiz for retake
app.post('/reset-quiz', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        // Delete previous answers if the user wants to retake the quiz
        await db.query('DELETE FROM user_answers WHERE user_id = $1', [userId]);

        // Redirect to the quiz-taking route
        res.redirect('/user-dashboard'); // Ensure /user-dashboard displays the quiz if no answers are found
    } catch (err) {
        console.error("Error resetting quiz:", err);
        res.status(500).send('Failed to reset quiz');
    }
});


// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Error destroying session during logout:", err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/login'); // Redirect to login page after logging out
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
