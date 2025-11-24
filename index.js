// ==============================
//  Discord Attendance Bot
//  Hosting: Railway
//  Libs: discord.js v14 + sqlite3
// ==============================

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

// ---- CONFIG (from environment / Railway) ----
const TOKEN = process.env.DISCORD_TOKEN;      // set in Railway
const CLIENT_ID = "1442491276896501841";      // your Application ID (fixed)
const GUILD_ID = process.env.GUILD_ID;        // your server ID (set in Railway)

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.log("❌ Please set DISCORD_TOKEN and GUILD_ID in Railway variables.");
  process.exit(1);
}

// ---- DATABASE (SQLite file in Railway container) ----
const db = new sqlite3.Database("./attendance.db");

db.run(
  `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    userName TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    fileUrl TEXT,
    fileName TEXT,
    createdAt TEXT NOT NULL
  );`
);

// ---- DISCORD CLIENT ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ---- SLASH COMMANDS ----
const commands = [
  new SlashCommandBuilder()
    .setName("attend_add")
    .setDescription("Add your attendance for a class")
    .addStringOption(opt =>
      opt
        .setName("class")
        .setDescription("Class or subject name")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName("status")
        .setDescription("present / absent")
        .setRequired(true)
        .addChoices(
          { name: "Present", value: "present" },
          { name: "Absent", value: "absent" }
        )
    )
    .addStringOption(opt =>
      opt
        .setName("reason")
        .setDescription("Reason (especially if absent)")
        .setRequired(false)
    )
    .addAttachmentOption(opt =>
      opt
        .setName("proof")
        .setDescription("Optional proof: photo/PDF/document")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("attend_updatefile")
    .setDescription("Update / add proof file for an old attendance record")
    .addIntegerOption(opt =>
      opt
        .setName("id")
        .setDescription("Attendance ID shown in /attend_list")
        .setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt
        .setName("proof")
        .setDescription("New proof file")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("attend_list")
    .setDescription("Show your recent attendance records")
    .addIntegerOption(opt =>
      opt
        .setName("limit")
        .setDescription("How many records to show (default 5, max 20)")
        .setRequired(false)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log("🔁 Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Error registering commands:", err);
  }
}

// ---- DB helpers ----
const runAsync = (sql, params = []) =>
  new Promise((res, rej) =>
    db.run(sql, params, function (err) {
      if (err) rej(err);
      else res(this);
    })
  );

const allAsync = (sql, params = []) =>
  new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows)))
  );

const getAsync = (sql, params = []) =>
  new Promise((res, rej) =>
    db.get(sql, params, (err, row) => (err ? rej(err) : res(row)))
  );

// ---- READY ----
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---- COMMAND HANDLER ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "attend_add") {
      const subject = interaction.options.getString("class");
      const status = interaction.options.getString("status");
      const reasonOpt = interaction.options.getString("reason");
      const proof = interaction.options.getAttachment("proof");

      const reason = reasonOpt || (status === "absent" ? "Not provided" : null);
      const createdAt = new Date().toISOString();
      const fileUrl = proof ? proof.url : null;
      const fileName = proof ? proof.name : null;

      const result = await runAsync(
        `INSERT INTO attendance
         (userId, userName, subject, status, reason, fileUrl, fileName, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          interaction.user.id,
          interaction.user.tag,
          subject,
          status,
          reason,
          fileUrl,
          fileName,
          createdAt
        ]
      );

      const id = result.lastID;

      const embed = new EmbedBuilder()
        .setTitle("✅ Attendance Saved")
        .addFields(
          { name: "ID", value: String(id), inline: true },
          { name: "Class", value: subject, inline: true },
          { name: "Status", value: status.toUpperCase(), inline: true }
        )
        .setFooter({ text: "Use /attend_list to see your records or /attend_updatefile to add proof later." })
        .setTimestamp(new Date(createdAt));

      if (reason) embed.addFields({ name: "Reason", value: reason });
      if (fileUrl) embed.addFields({ name: "Proof", value: fileName || fileUrl });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (interaction.commandName === "attend_updatefile") {
      const id = interaction.options.getInteger("id");
      const proof = interaction.options.getAttachment("proof");

      const rec = await getAsync(
        `SELECT * FROM attendance WHERE id = ? AND userId = ?`,
        [id, interaction.user.id]
      );

      if (!rec) {
        await interaction.reply({
          content: "❌ No attendance found with that ID (for you).",
          ephemeral: true
        });
        return;
      }

      await runAsync(
        `UPDATE attendance SET fileUrl = ?, fileName = ? WHERE id = ?`,
        [proof.url, proof.name, id]
      );

      const embed = new EmbedBuilder()
        .setTitle("🔄 Proof Updated")
        .setDescription(`Updated proof for ID **${id}**`)
        .addFields(
          { name: "Class", value: rec.subject, inline: true },
          { name: "Status", value: rec.status.toUpperCase(), inline: true },
          { name: "File", value: proof.name, inline: false }
        );

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (interaction.commandName === "attend_list") {
      let limit = interaction.options.getInteger("limit") || 5;
      if (limit > 20) limit = 20;
      if (limit < 1) limit = 1;

      const rows = await allAsync(
        `SELECT * FROM attendance
         WHERE userId = ?
         ORDER BY datetime(createdAt) DESC
         LIMIT ?`,
        [interaction.user.id, limit]
      );

      if (!rows.length) {
        await interaction.reply({
          content: "📭 No attendance records yet.",
          ephemeral: true
        });
        return;
      }

      const text = rows
        .map(r => {
          const date = new Date(r.createdAt).toLocaleString();
          let t = `**ID ${r.id}** | ${r.subject} | ${r.status.toUpperCase()} | ${date}`;
          if (r.reason) t += `\nReason: ${r.reason}`;
          if (r.fileUrl) t += `\nProof: ${r.fileUrl}`;
          return t;
        })
        .join("\n\n");

      await interaction.reply({
        content: `📒 **Your last ${rows.length} attendance records:**\n\n${text}`,
        ephemeral: true
      });
    }

  } catch (err) {
    console.error("❌ Error in command:", err);
    const msg = "⚠️ Something went wrong while processing your command.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true });
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
});

// ---- START ----
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();