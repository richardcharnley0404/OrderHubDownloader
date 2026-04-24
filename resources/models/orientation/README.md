---
license: mit
datasets:
- detection-datasets/coco
tags:
- orientation
- detection
- rotate
- rotation
- images
---
# Image Orientation Detector

This project implements a deep learning model to detect the orientation of images and determine the rotation needed to correct them. It uses a pre-trained EfficientNetV2 model from PyTorch, fine-tuned for the task of classifying images into four orientation categories: 0°, 90°, 180°, and 270°.

The model achieves **98.82% accuracy** on the validation set.

## Training Performance

This model was trained on a single NVIDIA H100 GPU, taking **5 hours, 5 minutes and 37 seconds** to complete.

## How It Works

The model is trained on a dataset of images, where each image is rotated by 0°, 90°, 180°, and 270°. The model learns to predict which rotation has been applied. The prediction can then be used to determine the correction needed to bring the image to its upright orientation.

The four classes correspond to the following rotations:

- **Class 0:** Image is correctly oriented (0°).
- **Class 1:** Image needs to be rotated **90° Clockwise** to be correct.
- **Class 2:** Image needs to be rotated **180°** to be correct.
- **Class 3:** Image needs to be rotated **90° Counter-Clockwise** to be correct.


## Dataset

The model was trained on several datasets:

- **Microsoft COCO Dataset:** A large-scale object detection, segmentation, and captioning dataset ([link](https://cocodataset.org/)).
- **AI-Generated vs. Real Images:** A dataset from Kaggle ([link](https://www.kaggle.com/datasets/cashbowman/ai-generated-images-vs-real-images)) was included to make the model aware of the typical orientations on different compositions found in art and illustrations.
- **TextOCR - Text Extraction from Images Dataset:** A dataset from Kaggle ([link](https://www.kaggle.com/datasets/robikscube/textocr-text-extraction-from-images-dataset?resource=download)) was included to improve the model's ability to detect the orientation of images containing text. (However over 1300 images needed have the orientation manually corrected like 0007a5a18213563f.jpg)
- **Personal Images:** A small, curated collection of personal photographs to include unique examples and edge cases.

The model was trained on a huge dataset of **189,018** unique images. Each image is augmented by being rotated in four ways (0°, 90°, 180°, 270°), creating a total of **756,072** samples. This augmented dataset was then split into **604,857 samples for training** and **151,215 samples for validation**.

## Usage

For detailed usage instructions, including how to run predictions, export to ONNX, and train the model, please refer to the [GitHub repository](https://github.com/duartebarbosadev/deep-image-orientation-detection).

## Performance Comparison (PyTorch vs. ONNX)

For a dataset of non-compressed 5055 images, the performance on a RTX 4080 running in **single-thread** was:

- **PyTorch (`predict.py`):** 135.71 seconds
- **ONNX (`predict_onnx.py`):** 60.83 seconds

---

For more in-depth information about the project, including the full source code, training scripts, and detailed documentation, please visit the [GitHub repository](https://github.com/duartebarbosadev/deep-image-orientation-detection).