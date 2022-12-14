const PORT = process.env.PORT || 8000;
const express = require('express')
const { MongoClient } = require('mongodb')
const jwt = require('jsonwebtoken')
const http = require('http');
const { Server } = require('socket.io');
const path = require('path')
require('dotenv').config()
const SpotifyWebApi = require('spotify-web-api-node');
const AuthMiddleware = require("./AuthMiddleware.js");

const Redis = require('ioredis');

const redisClient = new Redis({
    // Use Render Redis service name as host, red-xxxxxxxxxxxxxxxxxxxx
    host: process.env.REDIS_SERVICE_NAME,
    // Default Redis port
    port: process.env.REDIS_PORT || 6379,
});

const uri = process.env.MONGO_URI
const app = express();
app.use(express.json());
app.use(require('cors')());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.REDIRECT_URI,
        methods: ["GET", "POST", "PUT"]
    }
});

io.on('connection', (client) => {
    client.on('join', async ({userId}) => {
        await redisClient.set(userId, client.id);
    })

    client.on('newMessage', async ({message, userId, clickedUserId}) => {
        try {
            let result = await redisClient.get(clickedUserId);  
            
            if(result != null) {
                io.sockets.to(result)
                .emit('message', { message, user: userId });
            } else {
                const client = new MongoClient(uri);
                await client.connect()
                const database = client.db('app-data')
                const users = database.collection('users')
                await users.updateOne({user_id: clickedUserId}, { $addToSet: { new_messages: userId } })
            }       
        } catch(err) {
            console.log(err);
        }
    });

    client.on('leave', async ({userId}) => {
        await redisClient.del(userId);
    })
})

app.post("/authenticate", async (req, res) => {
    const client = new MongoClient(uri);

    const { email, id, artists, tracks, picture } = req.body;

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        const existingUser = await users.findOne({email});

        const token = jwt.sign({user_id: id}, process.env.JWT_SECRET, {
            expiresIn: 60 * 24 * 60
        });

        if(!existingUser) {
            const data = {
                user_id: id,
                email: email,
                onboarded: false,
                artists,
                tracks,
                picture,
                new_messages: [],
                matches: [],
                swiped_right: [],
                swiped_left: []
            }
    
            await users.insertOne(data);

            res.status(201).json({token, userId: id});
        } else {
            await users.updateOne({email}, { $set: { artists: artists, tracks: tracks, picture: picture } })

            res.status(201).json({token, userId: existingUser.user_id, onboarded: existingUser.onboarded, existingUser: existingUser})
        }
    } catch (err) {
        res.status(400).json('Invalid Credentials');
    }
})

app.post("/spotify", (req, res) => {
    const { code } = req.body

    const spotifyApi = new SpotifyWebApi({
        redirectUri: process.env.REDIRECT_URI,
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
    })

    const tokens = {
        accessToken: null,
        refreshToken : null,
        expiresIn : -1
    };
    
    spotifyApi
    .authorizationCodeGrant(code)
    .then(data => {
        tokens.accessToken = data.body.access_token;
        tokens.refreshToken = data.body.refresh_token;
        tokens.expiresIn = data.body.expires_in;
        res.send(tokens);
    })
    .catch(err => {
        res.send('Error Authenticating With Spotify')
    })
})

app.post("/refresh", (req, res) => {
    const refreshToken = req.body.refreshToken
    const spotifyApi = new SpotifyWebApi({
      redirectUri: process.env.REDIRECT_URI,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken,
    })
  
    spotifyApi
      .refreshAccessToken()
      .then(data => {
        res.json({
          accessToken: data.body.accessToken,
          expiresIn: data.body.expiresIn,
        })
      })
      .catch(err => {
        console.log(err)
        res.sendStatus(400)
       })
})

// Update User with a match
app.put('/addmatch', AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const { userId, matchedUserId, name, picture, matchName, matchPicture, matchNewMessages, newMessages } = req.body

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        if(await redisClient.hexists(`same-genre-users-${userId}`, matchedUserId)) {
            await redisClient.hdel(`same-genre-users-${userId}`, matchedUserId);

            const cachedUsers = await redisClient.hgetall(`same-genre-users-${userId}`);

            if(Object.keys(cachedUsers).length === 0) {
                await redisClient.del(`same-genre-users-${userId}`);
            }
        }

        const match = await users.findOne({ user_id: matchedUserId });

        if(match.swiped_right.includes(userId)) {
            const queryUser = { user_id: userId }

            const updateUserDocument = {
                $push: { matches: { user_id: matchedUserId } } ,
            }
    
            await users.updateOne(queryUser, updateUserDocument);

            const queryMatched = { user_id: matchedUserId }

            const updateMatchedDocument = {
                $push: { matches: { user_id: userId } } ,
                $pull: { swiped_right: userId }
            }
    
            await users.updateOne(queryMatched, updateMatchedDocument);

            res.send(true);
        } else {
            const query = { user_id: userId }

            const updateDocument = {
                $push: { swiped_right: matchedUserId }
            }
    
            await users.updateOne(query, updateDocument);

            res.send(false);
        }
    } finally {
        await client.close()
    }
});

app.put("/nomatch", async (req, res) => {
    const client = new MongoClient(uri);
    const { userId, matchedUserId } = req.body;

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        if(await redisClient.hexists(`same-genre-users-${userId}`, matchedUserId)) {
            await redisClient.hdel(`same-genre-users-${userId}`, matchedUserId);

            const cachedUsers = await redisClient.hgetall(`same-genre-users-${userId}`);

            if(Object.keys(cachedUsers).length === 0) {
                await redisClient.del(`same-genre-users-${userId}`);
            }
        }

        const query = { user_id: userId }

        const updateDocument = {
            $push: { swiped_left: matchedUserId }
        }

        await users.updateOne(query, updateDocument);

        res.sendStatus(200);
    } finally {
        await client.close()
    }
})

// Get individual user
app.get('/user', AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const userId = req.query.userId

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        const query = {user_id: userId}
        const user = await users.findOne(query)
        res.send(user)

    } finally {
        await client.close()
    }
})

app.put('/update-new-message', async (req, res) => {
    const client = new MongoClient(uri)
    const {userId, matchId} = req.body.data;

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        const query = {
            'user_id': userId
        }

        await users.updateOne(query, { $pull: { new_messages: matchId } });

        res.sendStatus(200);
    } finally {
        await client.close()
    }
})

// Get all matches of user in the Database
app.get('/matched-users', AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const userIds = JSON.parse(req.query.userIds).map(item => item.user_id)
    const userId = req.query.userId

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        const query = {
            'user_id': {
                '$in': userIds
            }
        }

        const matches = await users.find(query).toArray();
        const user = await users.findOne({ user_id: userId });

        res.json({ matches, user });
    } finally {
        await client.close()
    }
})

// Get all the Matching Genre Users in the Database
app.get('/same-genre-users', AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const params = JSON.parse(req.query.big_object)

    const genres = params.genres
    const matches = params.matches
    const right = params.swiped_right
    const left = params.swiped_left
    const userId = params.userId;

    const cachedUsers = await redisClient.hgetall(`same-genre-users-${userId}`);

    if(Object.keys(cachedUsers).length === 0) {
        try {
            await client.connect();
            const database = client.db('app-data');
            const users = database.collection('users');
    
            const query = {
                $and: [
                    {
                        user_id: { $ne: userId }
                    },
                    {
                        user_id: { $nin: matches.map(e => e.user_id) }
                    },
                    {
                        user_id: { $nin: right }
                    },
                    {
                        user_id: { $nin: left }
                    },
                    {
                        genres: { $elemMatch: { $in: genres } }
                    }
                ]
            }
    
            let allUsers = await users.find(query).limit(10).toArray();

            allUsers.forEach(async (user) => await redisClient.hset(`same-genre-users-${userId}`, user.user_id, JSON.stringify(user)));
            
            res.json(allUsers);
        } finally {
            await client.close()
        }
    } else {
        const users = Object.values(cachedUsers);
        let allUsers = [];
        users.forEach((user) => allUsers.push(JSON.parse(user)));
        res.json(allUsers);
    }
})

// Update a User in the Database
app.put('/user', AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const formData = req.body.formData
    const genres = req.body.genres

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')

        const query = {user_id: formData.user_id}

        const updateDocument = {
            $set: {
                first_name: formData.first_name,
                genres: genres,
                about: formData.about,
                matches: formData.matches,
                onboarded: true,
            },
        }
        const updatedUser = await users.findOneAndUpdate(query, updateDocument, {returnDocument: "after"});
        res.status(200).send(updatedUser);
    } finally {
        await client.close()
    }
})

// Get Messages by from_userId and to_userId
app.get('/messages', AuthMiddleware, async (req, res) => {
    const { userId, correspondingUserId } = req.query
    const client = new MongoClient(uri)

    try {
        await client.connect()
        const database = client.db('app-data')
        const messages = database.collection('messages')

        const query = {
            from_userId: userId, to_userId: correspondingUserId
        }

        const foundMessages = await messages.find(query).toArray();

        res.send(foundMessages)
    } finally {
        await client.close()
    }
})

// Add a Message to our Database
app.post('/message', async (req, res) => {
    const client = new MongoClient(uri)
    const message = req.body.message

    try {
        await client.connect()
        const database = client.db('app-data')
        const messages = database.collection('messages')

        const insertedMessage = await messages.insertOne(message)
        res.send(insertedMessage)
    } finally {
        await client.close()
    }
})

app.delete("/delete", AuthMiddleware, async (req, res) => {
    const client = new MongoClient(uri)
    const userId = req.body.userId;

    try {
        await client.connect()
        const database = client.db('app-data')
        const users = database.collection('users')
        const messages = database.collection('messages')

        const query = {user_id: userId}
        const user = await users.findOne(query)

        const matchesLength = user.matches.length;

        for(let match = 0; match < matchesLength; match++) {
            let matchId = user.matches[match].user_id

            await messages.deleteMany({
                from_userId: userId, to_userId: matchId
            });

            await messages.deleteMany({
                from_userId: matchId, to_userId: userId
            });

            const query = { user_id: matchId }

            const updateDocument = {
                $pull: { matches: { user_id: userId } },
                $pull: { new_messages: userId }
            }

            await users.updateOne(query, updateDocument)
        }

        await users.deleteOne({user_id: userId});

        res.sendStatus(201)
    } finally {
        await client.close()
    }
})

//-------------------DEPLOYMENT----------------//
// ORDER MATTERS! THIS MUST BE BELOW ALL ROUTES ABOVE
// if (process.env.NODE_ENV === "production") {
//     app.use(express.static(path.join(__dirname, "/client/build")));
  
//     app.get("*", (req, res) =>
//       res.sendFile(path.resolve(__dirname, "client", "build", "index.html"))
//     );
// } else {
//     app.get("/", (req, res) => {
//       res.send("API is running...");
//     });
// }

server.listen(PORT, () => {
    console.log('server running on PORT ' + PORT)
})
