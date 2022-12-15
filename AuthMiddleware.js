const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
    const { cookie } = req.headers;

    console.log(req);

    if (!cookie) {
        // Status code 401 means unauthorized
        return res.status(401).json({verified: false})
    } else {
        let cookies = cookie.split("; ");

        let authToken = "";

        let userId = "";
        
        for(let i = 0; i < cookies.length; i++) {
            let current = cookies[i].split("=");

            if(current[0] === "AuthToken") {
                authToken = current[1];
            }

            if(current[0] === "UserId") {
                userId = current[1];
            }
        }

        if(!authToken || !userId) {
            return res.status(401).json({verified: false})
        }

        jwt.verify(authToken, process.env.JWT_SECRET, (err, payload) => {
            if (err || payload.user_id !== userId) {
                return res.status(401).json({verified: false})
            } else {
                next();
            }
        })
    }
}