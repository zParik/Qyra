use printpdf::{
    Image, ImageTransform, ImageXObject, Mm, Px, PdfDocument,
    ColorSpace, ColorBits,
};
use std::fs::File;
use std::io::BufWriter;
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Convert a list of images (PNG/JPG/WebP) to a PDF.
#[tauri::command]
pub fn images_to_pdf(
    image_paths: Vec<String>,
    output: Option<String>,
) -> AppResult<String> {
    if image_paths.is_empty() {
        return Err(AppError::Invalid("No images provided".to_string()));
    }

    let out = output.unwrap_or_else(|| temp_output_path(&image_paths[0], "converted"));

    let (doc, page1, layer1) = PdfDocument::new("Images to PDF", Mm(210.0), Mm(297.0), "Layer 1");

    for (i, img_path) in image_paths.iter().enumerate() {
        let img = ::image::open(img_path)
            .map_err(|e| AppError::Other(format!("Failed to open image {}: {}", img_path, e)))?;

        let (width_px, height_px) = ::image::GenericImageView::dimensions(&img);

        // Scale to fit A4 (210x297mm) maintaining aspect ratio
        let max_w_mm = 190.0_f32;
        let max_h_mm = 270.0_f32;
        let aspect = width_px as f32 / height_px as f32;
        let (w_mm, h_mm) = if aspect > max_w_mm / max_h_mm {
            (max_w_mm, max_w_mm / aspect)
        } else {
            (max_h_mm * aspect, max_h_mm)
        };

        let (current_page, current_layer) = if i == 0 {
            (page1.clone(), layer1.clone())
        } else {
            doc.add_page(Mm(210.0), Mm(297.0), "Layer 1")
        };

        let layer = doc.get_page(current_page).get_layer(current_layer);

        // Convert to RGB8 for printpdf
        let rgb = img.to_rgb8();
        let raw: Vec<u8> = rgb.into_raw();
        let pdf_image = Image::from(ImageXObject {
            width: Px(width_px as usize),
            height: Px(height_px as usize),
            color_space: ColorSpace::Rgb,
            bits_per_component: ColorBits::Bit8,
            interpolate: true,
            image_data: raw,
            image_filter: None,
            smask: None,
            clipping_bbox: None,
        });

        let x_mm = (210.0 - w_mm) / 2.0;
        let y_mm = (297.0 - h_mm) / 2.0;

        // DPI conversion: 1 mm = 2.8346 pt, so scale = mm_size / (px * mm_per_px)
        // At 96 DPI: 1 px = 0.264583 mm; at 72 DPI: 1 px = 0.352778 mm
        let scale_x = w_mm / (width_px as f32 * 0.264583_f32);
        let scale_y = h_mm / (height_px as f32 * 0.264583_f32);

        pdf_image.add_to_layer(
            layer,
            ImageTransform {
                translate_x: Some(Mm(x_mm)),
                translate_y: Some(Mm(y_mm)),
                scale_x: Some(scale_x),
                scale_y: Some(scale_y),
                ..Default::default()
            },
        );
    }

    let file = File::create(&out)?;
    doc.save(&mut BufWriter::new(file)).map_err(|e| AppError::Pdf(e.to_string()))?;
    Ok(out)
}
