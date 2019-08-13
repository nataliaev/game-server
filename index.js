const express = require("express");
const Sse = require("json-sse");
const bodyParser = require("body-parser");
const cors = require("cors");
const Sequelize = require("sequelize");
const bcrypt = require("bcrypt");
const { toData, toJWT } = require("./auth/jwt");

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://postgres:secret@localhost:5432/postgres";
const db = new Sequelize(databaseUrl);

db.sync({ force: false }).then(() => {
  console.log("Database synced");
});

const User = db.define("user", {
  name: {
    type: Sequelize.STRING,
    allowNull: false
  },
  email: {
    type: Sequelize.STRING,
    allowNull: false
  },
  password: {
    type: Sequelize.STRING,
    allowNull: false
  }
});

const Room = db.define("room", {
  name: Sequelize.STRING,
  stage: {
    type: Sequelize.INTEGER,
    defaultValue: 10
  },
  round: {
    type: Sequelize.INTEGER,
    defaultValue: 1
  },
  status: {
    type: Sequelize.STRING,
    defaultValue: "joining"
  }
});

const Choice = db.define("choice", {
  value: Sequelize.INTEGER,
  round: Sequelize.INTEGER
});

Choice.belongsTo(User);
Choice.belongsTo(Room);
User.belongsTo(Room);
User.hasMany(Choice);
Room.hasMany(User);
Room.hasMany(Choice);

const stream = new Sse();

const app = express();

const middleware = cors();
app.use(middleware);

const jsonParser = bodyParser.json();
app.use(jsonParser);

app.get("/stream", async (request, response) => {
  const rooms = await Room.findAll({ include: [User, Choice] });

  const data = JSON.stringify(rooms);
  stream.updateInit(data);

  stream.init(request, response);
});

app.post("/choice", async (request, response) => {
  console.log("request.body test:", request.body);
  const { value, userId, roomId } = request.body;

  const room = await Room.findByPk(roomId, { include: [User, Choice] });

  if (room.users.length === 2) {
    const choices = await Room.findOne({
      where: { id: room.id, round: room.round },
      include: [User, Choice]
    });

    const otherChoice = choices.choices.filter(
      choice => choice.round === room.round
    );

    await Choice.create({ userId, roomId, value, round: room.round });

    if (otherChoice.length) {
      const [other] = otherChoice;

      const next =
        parseInt(value) === parseInt(other.value)
          ? room.stage + 1
          : room.stage - 1;

      if (next < 0 || next > 20) {
        await room.update({ status: "done" });
      } else {
        await room.update({ round: room.round + 1, stage: next });
      }
    }
  } else {
    response.send("This game is not being played right now");
  }

  const rooms = await Room.findAll({
    include: [User, Choice]
  });

  const data = JSON.stringify(rooms);

  stream.updateInit(data);
  stream.send(data);

  response.send(rooms);
});

app.post("/rooms", async (request, response) => {
  const room = await Room.create(request.body);

  const rooms = await Room.findAll({
    include: [User, Choice]
  });

  const data = JSON.stringify(rooms);

  stream.updateInit(data);
  stream.send(data);

  response.send(rooms);
});

app.put("/rooms/:roomId", async (request, response) => {
  const room = await Room.findByPk(request.params.roomId, {
    include: [User, Choice]
  });

  const { userId } = request.body;

  if (room.status === "joining" && room.users.length < 2) {
    await User.update(
      { roomId: request.params.roomId },
      { where: { id: userId } }
    );
  }

  const rooms = await Room.findAll({ include: [User, Choice] });

  const data = JSON.stringify(rooms);

  stream.updateInit(data);
  stream.send(data);

  response.send(rooms);
});

app.post("/users", async (request, response) => {
  const user = await User.create({
    name: request.body.name,
    email: request.body.email,
    password: bcrypt.hashSync(request.body.password, 10)
  });

  response.send(user);
});

function auth(req, res, next) {
  const auth =
    req.headers.authorization && req.headers.authorization.split(" ");
  if (auth && auth[0] === "Bearer" && auth[1]) {
    try {
      const data = toData(auth[1]);
      User.findByPk(data.userId)
        .then(user => {
          if (!user) return next("User does not exist");

          req.user = user;
          next();
        })
        .catch(next);
    } catch (error) {
      res.status(400).send({
        message: `Error ${error.name}: ${error.message}`
      });
    }
  } else {
    res.status(401).send({
      message: "Please supply some valid credentials"
    });
  }
}

app.post("/logins", (req, res) => {
  if (!req.body.name || !req.body.password) {
    res.status(400).send({
      message: "Please supply a valid name and password"
    });
  } else {
    // 1. find user based on name
    User.findOne({
      where: {
        name: req.body.name
      }
    })
      .then(entity => {
        if (!entity) {
          res.status(400).send({
            message: "User with that email does not exist"
          });
        }

        // 2. use bcrypt.compareSync to check the password against the stored hash
        if (bcrypt.compareSync(req.body.password, entity.password)) {
          // 3. if the password is correct, return a JWT with the userId of the user (user.id)

          res.send({
            jwt: toJWT({ userId: entity.id }),
            name: entity.name,
            id: entity.id
          });
        } else {
          res.status(400).send({
            message: "Password was incorrect"
          });
        }
      })
      .catch(err => {
        console.error(err);
        res.status(500).send({
          message: "Something went wrong"
        });
      });
  }
});

const port = process.env.PORT || 5000;

app.listen(port, () => console.log(`Listening on :${port}`));
