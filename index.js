const express = require("express");
const Sse = require("json-sse");
const bodyParser = require("body-parser");
const cors = require("cors");
const Sequelize = require("sequelize");
const bcrypt = require("bcrypt");

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://postgres:secret@localhost:5432/postgres";
const db = new Sequelize(databaseUrl);

db.sync({ force: true }).then(() => {
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
  },
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
  const rooms = await Room.findAll({ include: [User, Choice]});

  const data = JSON.stringify(rooms);
  stream.updateInit(data);

  stream.init(request, response);
});

app.post("/choice", async (request, response) => {
  console.log("request.body test:", request.body);
  const { value, userId, roomId } = request.body;

  const room = await Room.findByPk(roomId);

  let entity;

  if (room.status === "started") {
    const choices = await Room.findOne({ where: { id: room.id, round: room.round }, include: [User, Choice] });

    entity = await Choice.create({ userId, roomId, value, round: room.round });

    if (choices.choices.length) {
      const [other] = choices.choices;

      const next = parseInt(value) === parseInt(other.value) ? room.stage + 1 : room.stage - 1;

      if (next < 0 || next > 20) {
        await room.update({ status: "done" });
      } else {
        await room.update({ stage: next });
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

  response.send(entity);
});

app.post("/rooms", async (request, response) => {
  const room = await Room.create(request.body);

  const rooms = await Room.findAll({
    include: [User, Choice]
  });

  const data = JSON.stringify(rooms);

  stream.updateInit(data);
  stream.send(data);

  response.send(room);
});

app.put("/rooms/:roomId", async (request, response) => {
  const room = await Room.findByPk(request.params.roomId);

  const { userId } = request.body;

  if (room.status === "joining" && room.users.length < 2) {
    await User.update({ roomId: request.params.roomId }, { where: { userId } });
  }

  const data = JSON.stringify(room);

  stream.updateInit(data);
  stream.send(data);

  response.send(room);
});

app.post("/users", async (request, response) => {
  const user = User.create({
    name: request.body.name,
    email: request.body.email,
    password: bcrypt.hashSync(request.body.password, 10)
  });
  const data = JSON.stringify(user);

  stream.updateInit(data);
  stream.send(data);

  response.send(user);
});

const port = process.env.PORT || 5000;

app.listen(port, () => console.log(`Listening on :${port}`));
