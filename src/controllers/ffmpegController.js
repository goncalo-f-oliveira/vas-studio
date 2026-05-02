const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const multer = require("multer");

// Configuração do FFmpeg / FFprobe
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// Configuração do multer para upload de vídeo
const upload = multer({ dest: "uploads/" });

// Cria a pasta de output se não existir
const outputDir = path.join(__dirname, "../../output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Verifica se um ficheiro de vídeo tem stream de áudio
function temAudio(caminhoVideo) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(caminhoVideo, (err, metadata) => {
      if (err) return reject(err);
      const audio = metadata.streams.some((s) => s.codec_type === "audio");
      resolve(audio);
    });
  });
}

exports.processarVideo = async (req, res) => {
  try {
    console.log("Iniciando processamento de vídeo...");

    if (!req.file) {
      console.error("Nenhum vídeo enviado");
      return res.status(400).json({
        success: false,
        error: "Nenhum vídeo enviado",
      });
    }

    let audiosData = [];
    try {
      audiosData = JSON.parse(req.body.audiosData || "[]");
    } catch (e) {
      console.error("Erro ao parsear audiosData:", e);
      return res.status(400).json({
        success: false,
        error: "Formato inválido para dados dos áudios",
      });
    }

    console.log("Dados dos áudios recebidos:", audiosData);

    if (audiosData.length === 0) {
      console.error("Nenhum áudio selecionado");
      return res.status(400).json({
        success: false,
        error: "Nenhum áudio selecionado",
      });
    }

    // Validação dos áudios
    const projectRoot = path.join(__dirname, "../..");
    const validatedAudios = [];

    for (const audio of audiosData) {
      const absolutePath = path.join(
        projectRoot,
        "public",
        "ambienteSons",
        audio.path
      );

      const validPath = path.join(projectRoot, "public", "ambienteSons");
      if (!absolutePath.startsWith(validPath)) {
        console.error("Caminho de áudio inválido:", absolutePath);
        return res.status(400).json({
          success: false,
          error: "Caminho de áudio inválido",
        });
      }

      if (!fs.existsSync(absolutePath)) {
        console.error("Arquivo de áudio não encontrado:", absolutePath);
        return res.status(400).json({
          success: false,
          error: `Arquivo de áudio não encontrado: ${audio.path}`,
        });
      }

      validatedAudios.push({
        path: absolutePath,
        duration: parseFloat(audio.duration) || 2,
        delay: parseInt(audio.delay) || 1000,
        volume: parseFloat(audio.volume) || 1.0,
        speed: parseFloat(audio.speed) || 1.0,
      });
    }

    const videoPath = req.file.path;
    const outputFilename = `video_editado_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    // Deteta se o vídeo original tem áudio
    const videoTemAudio = await temAudio(videoPath);
    console.log("Vídeo tem áudio original?", videoTemAudio);

    console.log("Iniciando processamento FFmpeg...");
    console.log("Vídeo:", videoPath);
    console.log("Áudios:", validatedAudios);

    await new Promise((resolve, reject) => {
      const command = ffmpeg().input(videoPath);

      // Adiciona cada áudio como input
      validatedAudios.forEach((audio) => {
        command.input(audio.path);
      });

      const filters = [];
      const audioStreams = []; // nomes dos streams de áudio prontos para mistura

      // Inclui o áudio original SÓ SE existir
      if (videoTemAudio) {
        audioStreams.push("0:a");
      }

      validatedAudios.forEach((audio, index) => {
        const audioIndex = index + 1; // input 0 é o vídeo
        const streamName = `aud${index}`;

        filters.push({
          filter: "atrim",
          options: `end=${audio.duration}`,
          inputs: `${audioIndex}:a`,
          outputs: `${streamName}_trimmed`,
        });

        filters.push({
          filter: "atempo",
          options: audio.speed.toString(),
          inputs: `${streamName}_trimmed`,
          outputs: `${streamName}_sped`,
        });

        filters.push({
          filter: "volume",
          options: audio.volume.toString(),
          inputs: `${streamName}_sped`,
          outputs: `${streamName}_vol`,
        });

        filters.push({
          filter: "adelay",
          options: `${audio.delay}|${audio.delay}`,
          inputs: `${streamName}_vol`,
          outputs: streamName,
        });

        audioStreams.push(`[${streamName}]`);
      });

      // Decide o stream final de áudio
      let finalAudioLabel;

      if (audioStreams.length === 1) {
        // Só uma faixa — não precisa de amix
        const unico = audioStreams[0];

        if (unico.startsWith("[")) {
          // já é um label tipo [aud0] — usa-o diretamente
          finalAudioLabel = unico;
        } else {
          // é o "0:a" cru — precisa de um filtro identidade para criar um label
          filters.push({
            filter: "anull",
            inputs: unico,
            outputs: "audiofinal",
          });
          finalAudioLabel = "[audiofinal]";
        }
      } else {
        // 2 ou mais faixas — mistura
        filters.push({
          filter: "amix",
          options: {
            inputs: audioStreams.length,
            duration: "first",
          },
          inputs: audioStreams,
          outputs: "audiofinal",
        });
        finalAudioLabel = "[audiofinal]";
      }

      console.log("Filtros complexos:", filters);
      console.log("Label final do áudio:", finalAudioLabel);

      command
        .complexFilter(filters)
        .outputOptions([
          "-map",
          "0:v",
          "-map",
          finalAudioLabel,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-shortest",
        ])
        .on("start", (commandLine) => {
          console.log("Comando FFmpeg executado:", commandLine);
        })
        .on("progress", (progress) => {
          if (progress && progress.percent != null) {
            console.log(`Processando: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log("Processamento concluído com sucesso!");
          resolve();
        })
        .on("error", (err, stdout, stderr) => {
          console.error("Erro no FFmpeg:", err);
          console.error("Saída FFmpeg (stdout):", stdout);
          console.error("Erro FFmpeg (stderr):", stderr);
          reject(new Error("Erro ao processar vídeo com FFmpeg"));
        })
        .save(outputPath);
    });

    console.log("Vídeo processado com sucesso:", outputPath);

    res.status(200).json({
      success: true,
      downloadUrl: `/output/${outputFilename}`,
    });
  } catch (err) {
    console.error("Erro no processamento:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Erro durante o processamento do vídeo",
    });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
};